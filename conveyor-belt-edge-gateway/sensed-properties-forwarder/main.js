/**
 * Edge half of iDT_CB
 * Executed on the conveyor belt edge gateway (E_CB): the proxy of
 * the belt. It hosts SensedProperties in this machine's repository and keeps it
 * in step with the belt PLC: each state the PLC publishes on the industrial
 * communication gateway (ICG) is written through the standard Submodel API,
 * with RecordedAt, the proxy's own timestamp. It reads and forwards; it takes
 * no decisions.
 *
 * The pick window is a state, not a stream of events: when the repository
 * cannot be written, only the latest value of each element waits and is
 * written as soon as it can be (latest value wins).
 *
 *@SUBS: dynamic-sorting-cell/conveyor-belt/pick-window
 *@SUBS: dynamic-sorting-cell/conveyor-belt/counters
 */

import { setTimeout as sleep } from 'node:timers/promises'
import mqtt from 'mqtt'
import { Configuration, SubmodelRepositoryClient } from 'basyx-typescript-sdk'
import { EdgeSubmodel, describeError } from './edge-submodel.js'

const TOPICS = {
    pickWindow: 'dynamic-sorting-cell/conveyor-belt/pick-window',
    counters: 'dynamic-sorting-cell/conveyor-belt/counters',
}

const config = {
    icg: process.env.ICG_URL || 'mqtt://industrial-communication-gateway:1883',
    repositoryUrl: process.env.REPOSITORY_URL || 'http://conveyor-belt-edge-gateway:8091',
    plantRegistryUrl: process.env.PLANT_REGISTRY_URL || 'http://plant-server:8081',
    assetId: process.env.ASSET_ID || 'https://plant.example/assets/conveyor-belt/CB-0001',
    file: process.env.SUBMODEL_FILE || '/usr/share/aas/sensed-properties-forwarder/sensed-properties-submodel.json',
    registrationInterval: getDuration( 'REGISTRATION_INTERVAL', '30s' ),
}

const COLOURS = {
    INFO: '\x1b[34m',       // blue
    cyan: '\x1b[36m',       // cyan
    green: '\x1b[32m',      // green
    DEBUG: '\x1b[90m',      // grey
    magenta: '\x1b[35m',    // magenta
    ERROR: '\x1b[31m',      // red
    WARN: '\x1b[33m',       // yellow
    bold: '\x1b[1m',
    reset: '\x1b[0m',
}

class SensedPropertiesForwarder {

    pendingValues = {} // element -> latest value still to write
    isWriting = false

    constructor( config ) {
        this.config = config
        this.edgeSubmodel = new EdgeSubmodel({ ...config, log })
        this.localRepository = new Configuration({ basePath: config.repositoryUrl })
        this.submodelRepositoryClient = new SubmodelRepositoryClient()
    }

    async start() {
        this.submodelIdentifier = await this.edgeSubmodel.host()

        this.icg = mqtt.connect( this.config.icg, {
            clientId: 'conveyor-belt-edge-gateway',
            protocolVersion: 5,
            reconnectPeriod: 2000,
        })

        this.icg.on( 'connect', () => this.onConnect() )
        this.icg.on( 'message', ( topic, payload ) => this.onMessage( topic, payload ))
        this.icg.on( 'error', ( error ) => log( 'ICG connection error', {
            error: error.message,
        }, 'WARN' ))
    }

    stop() {
        this.icg.end(() => process.exit( 0 ))
    }

    onConnect() {

        log( 'connected to the ICG' )

        this.icg.subscribe([
            TOPICS.pickWindow,
            TOPICS.counters,
        ], {
            qos: 1,
        })
    }

    onMessage( topic, payload ) {
        const message = parseMessage( payload )

        // Guard message
        if ( ! message ) return

        switch ( topic ) {

            case TOPICS.pickWindow:

                this.updateSensedProperties({
                    CurrentObject: {
                        ObjectIdentifier: message.objectIdentifier,
                        ObjectColour: message.objectColour,
                        DetectedAt: message.detectedAt,
                        RecordedAt: new Date().toISOString(),
                    },
                })

                break

            default:

                this.updateSensedProperties({
                    PackagesDetected: message.packagesDetected,
                })

                break
        }
    }

    updateSensedProperties( values ) {
        Object.assign( this.pendingValues, values )
        void this.writePendingValues()
    }

    async writePendingValues() {

        // Guard writing
        if ( this.isWriting ) return

        this.isWriting = true
        while ( 0 < Object.keys( this.pendingValues ).length ) {
            const values = this.pendingValues
            this.pendingValues = {}

            const result = await this.submodelRepositoryClient.patchSubmodelByIdValueOnly({
                configuration: this.localRepository,
                submodelIdentifier: this.submodelIdentifier,
                body: values,
            })

            if ( result.success ) {

                log( 'iDT_CB updated', values )

            } else {

                // unless a newer value has arrived
                this.pendingValues = { ...values, ...this.pendingValues }

                log( 'iDT_CB not updated, retrying with the latest value', {
                    elements: Object.keys( values ).join( ' ' ),
                    error: describeError( result ),
                }, 'WARN' )

                await sleep( 1000 )
            }
        }
        this.isWriting = false
    }
}

const forwarder = new SensedPropertiesForwarder( config )
await forwarder.start()

const bye = () => forwarder.stop()
process.once( 'SIGTERM', bye )
process.once( 'SIGINT', bye )

function parseMessage( payload ) {
    try {
        return JSON.parse( payload.toString() )
    } catch {
        log( 'ERROR: parse payload', { payload: payload.toString() }, 'ERROR' )
        return undefined // not a message of this cell
    }
}

function getDuration( name, fallback ) {
    const text = process.env[ name ] || fallback
    const match = /^(\d+(?:\.\d+)?)(ms|s|m)$/.exec( text )
    if ( ! match ) throw new Error(`${ name } must be a duration such as 700ms or 2s, not "${ text }"`)
    return Number( match[ 1 ]) * { ms: 1, s: 1000, m: 60_000 }[ match[ 2 ]]
}

function log( message, fields = {}, level = 'INFO' ) {
    const details = Object.entries( fields ).map(([ key, value ]) =>
        ` ${ key }=${ 'object' === typeof value ? JSON.stringify( value ) : value }` ).join( '' )

    console.log( `${ COLOURS[ level ] } time=${ Date.now() } level=${ level } msg="${ message }"${ details } ${ COLOURS.reset }` )
}
