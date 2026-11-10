/**
 * Simulated Conveyor Belt (CB)
 * - its PLC
 * - its colour sensor
 * - the packages on the belt
 *
 * The PLC publishes on the Industrial Communication Gateway (ICG):
 * - the state of the pick window
 * - a counter
 *
 * The arm's "object picked" message stands in for the presence sensor that
 * would see the package leave the pick window. The belt stops each package
 * in the pick window and waits for the arm.
 *
 *@PUBS: dynamic-sorting-cell/conveyor-belt/pick-window
 *@PUBS: dynamic-sorting-cell/conveyor-belt/counters
 *@SUBS: dynamic-sorting-cell/robotic-arm/object-picked
 */

import { randomBytes } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import mqtt from 'mqtt'

const TOPICS = {
    pickWindow: 'dynamic-sorting-cell/conveyor-belt/pick-window',
    counters: 'dynamic-sorting-cell/conveyor-belt/counters',
    objectPicked: 'dynamic-sorting-cell/robotic-arm/object-picked',
}

const config = {
    icg: process.env.ICG_URL || 'mqtt://industrial-communication-gateway:1883',
    travelTimeMin: getDuration( 'TRAVEL_TIME_MIN', '2s' ),
    travelTimeMax: getDuration( 'TRAVEL_TIME_MAX', '4s' ),
    metallicShare: Number( process.env.METALLIC_SHARE || 0.5 ),
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

class ConveyorBelt {

    counters = {
        packagesDetected: 0,
        updatedAt: new Date().toISOString(),
    }

    pickWindow = {
        objectIdentifier: '',
        objectColour: 'none',
        detectedAt: new Date().toISOString(),
    }

    onPicked = null

    constructor( config ) {
        this.config = config

        this.icg = mqtt.connect( config.icg, {
            clientId: 'conveyor-belt-plc',
            protocolVersion: 5,
            reconnectPeriod: 2000,
        })

        this.icg.on( 'connect', () => this.onConnect() )
        this.icg.on( 'message', ( topic, payload ) => this.onMessage( topic, payload ))
        this.icg.on( 'error', ( error ) => log( 'ICG connection error', {
            error: error.message
        }, 'WARN' ))
    }

    async run() {

        log( 'conveyor belt PLC started', {
            icg: this.config.icg,
        })

        // Waiting for the connection
        await new Promise(( resolve ) => this.icg.once( 'connect', resolve ))

        for (;;) {

            const objectIdentifier = await this.bringNextPackage()

            await this.waitForPick( objectIdentifier )
            log( 'pick window free: package picked by the arm', {
                object: objectIdentifier,
            })

            this.setPickWindow( '', 'none' )
            log( 'belt running' )
        }
    }

    async bringNextPackage() {

        const travelTime = this.drawTravelTime()
        log( 'Travel time', { travelTime }, 'DEBUG' )
        await sleep( travelTime )

        const objectIdentifier = `PKG-${
            randomBytes( 3 ).toString( 'hex' ).toUpperCase() }`
        const isMetallic = Math.random() < this.config.metallicShare
        this.setPickWindow( objectIdentifier, isMetallic ? 'red' : 'green' )

        this.countPackage( 'packagesDetected' )
        log( 'belt stopped: package in the pick window', {
            object: objectIdentifier,
            colour: this.pickWindow.objectColour,
            material: isMetallic ? 'metallic' : 'non-metallic',
        })

        return objectIdentifier
    }

    stop() {
        this.icg.end(() => process.exit( 0 ))
    }

    onConnect() {

        log( 'connected to the ICG' )

        this.icg.subscribe([
            TOPICS.objectPicked,
        ], {
            qos: 1,
        })

        this.publishState()
    }

    onMessage( topic, payload ) {
        try {
            const objectPicked = JSON.parse( payload.toString() )
            log( 'Message', { topic, payload: objectPicked }, 'DEBUG' )
            this.onPicked?.( objectPicked.objectIdentifier )
        } catch {
            log( 'ERROR on message', { topic, payload: payload.toString() }, 'DEBUG' )
            // not a message of this cell
        }
    }

    waitForPick( objectIdentifier ) {
        log( 'Awaiting to pick', { objectIdentifier }, 'DEBUG' )
        return new Promise(( resolve ) => {
            this.onPicked = ( picked ) => {
                log( 'Picked', { objectIdentifier, picked }, 'DEBUG' )
                if ( picked !== objectIdentifier ) return //@WARN Wait forever
                this.onPicked = null
                resolve( picked )
            }
        })
    }

    setPickWindow( objectIdentifier, objectColour ) {
        this.pickWindow = {
            objectIdentifier,
            objectColour,
            detectedAt: new Date().toISOString(),
        }
        this.publish( TOPICS.pickWindow, this.pickWindow )
    }

    countPackage( counter ) {
        this.counters[ counter ]++
        this.counters.updatedAt = new Date().toISOString()
        this.publish( TOPICS.counters, this.counters )
    }

    publishState() {
        this.publish( TOPICS.pickWindow, this.pickWindow )
        this.publish( TOPICS.counters, this.counters )
    }

    publish( topic, message ) {
        if ( this.icg.connected ) {
            const icgMessage = JSON.stringify( message )
            log( 'Publish', { topic, message: icgMessage }, 'DEBUG' )
            this.icg.publish( topic, icgMessage, {
                qos: 1,
                retain: true, // a subscriber that connects later gets the current state at once
            })
        }
    }

    drawTravelTime() {
        return this.config.travelTimeMin + Math.random() * ( this.config.travelTimeMax - this.config.travelTimeMin )
    }
}

const conveyorBelt = new ConveyorBelt( config )

const bye = () => conveyorBelt.stop()
process.once( 'SIGTERM', bye )
process.once( 'SIGINT', bye )

await conveyorBelt.run()

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
