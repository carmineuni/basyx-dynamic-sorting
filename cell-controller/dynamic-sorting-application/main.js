/**
 * The purpose logic of cDT_DS
 *
 * cDT_DS is the purpose-oriented composite digital twin of the dynamic sorting
 * cell, on the cell controller. cDT_DS is the AAS of the cell together with this
 * program: the AAS says
 * - what the cell is made of (HierarchicalStructures),
 * - what it is for (SortingRules) and
 * - how it is doing (OperationalData);
 * the program takes the decisions, through the standard AAS API of the cell
 * controller, of the plant server and of the edge gateways.
 *
 * Standard output carries one JSON record per package and, every
 * PACKAGES_PER_SUMMARY packages, a summary; the log goes to standard error.
 */

import { setTimeout as sleep } from 'node:timers/promises'
import mqtt from 'mqtt'
import { Composition, aasApiRequests } from './composition.js'
import { EdgeSubmodel } from './edge-submodel.js'
import { log } from './log.js'
import { DynamicSorting } from './sorting.js'

const SUBMODEL_UPDATED_TOPIC = 'basyx/submodelrepository/submodel/updated'

const config = {
    cellAssetId: process.env.CELL_ASSET_ID || 'https://plant.example/assets/dynamic-sorting-cell/DSC-0001',
    repositoryUrl: process.env.REPOSITORY_URL || 'http://cell-controller:8093',
    plantRegistryUrl: process.env.PLANT_REGISTRY_URL || 'http://plant-server:8081',
    eventBroker: process.env.EVENT_BROKER_URL || 'mqtt://event-broker:1883',
    submodelFiles: [
        process.env.SORTING_RULES_FILE || '/usr/share/aas/dynamic-sorting-application/sorting-rules-submodel.json',
        process.env.OPERATIONAL_DATA_FILE || '/usr/share/aas/dynamic-sorting-application/operational-data-submodel.json',
    ],
    registrationInterval: getDuration( 'REGISTRATION_INTERVAL', '30s' ),
    reconciliationInterval: getDuration( 'RECONCILIATION_INTERVAL', '5s' ),
    packagesPerSummary: Number( process.env.PACKAGES_PER_SUMMARY ?? 20 ),
}

class DynamicSortingApplication {

    isLookRequested = false
    haveSortingRulesChanged = false
    wakeUp = null // ends the current wait for a look request

    constructor( config ) {
        this.config = config
    }

    async start() {
        await this.hostSubmodels()
        await this.compose()
        this.logComposition()

        this.dynamicSorting = new DynamicSorting({
            ...this.config,
            submodels: this.composition.submodels,
            sortingRules: this.sortingRules,
            retryIn: ( milliseconds ) => setTimeout(() => this.requestLook(), milliseconds ),
        })
        await this.dynamicSorting.setState( 'Running' )
        this.dynamicSorting.requestsAtLastRecord = aasApiRequests.count // the composition is not charged to the first package

        this.subscribeToChangeEvents()

        log( 'cDT_DS running: waiting for packages in the pick window', {
            reconciliationIntervalMs: this.config.reconciliationInterval,
        })

        await this.run()
    }

    async stop() {
        if ( this.dynamicSorting ) {
            await this.dynamicSorting.setState( 'Stopped' ).catch(() =>
                log( 'cannot record the Stopped state', {}, 'WARN' ))
        }
        log( 'cDT_DS stopped' )
        process.exit( 0 )
    }

    // SortingRules and OperationalData live on this machine
    // and are registered in the plant registry like those of the edge gateways
    async hostSubmodels() {
        for ( const file of this.config.submodelFiles ) {
            await new EdgeSubmodel({
                ...this.config,
                assetId: this.config.cellAssetId,
                file,
                log,
            }).host()
        }
    }

    // Start-up: compose cDT_DS,
    // retrying until every twin it needs is registered and reachable
    async compose() {
        for ( let delay = 2000 ; ; delay = Math.min( delay * 2, 30_000 )) {
            try {
                this.composition = await Composition.compose( this.config.plantRegistryUrl, this.config.cellAssetId )
                this.sortingRules = await this.composition.getSortingRules()
                return
            } catch ( error ) {
                log( 'cDT_DS not ready yet', {
                    reason: error.message.slice( 0, 200 ),
                    retryInMs: delay,
                })
                await sleep( delay )
            }
        }
    }

    logComposition() {
        log( 'the cell is made of', {
            parts: this.composition.parts.join( ' ' ),
        })
        log( 'cDT_DS composed', {
            sensedProperties: this.composition.submodels.sensedProperties.id,
            controlCommands: this.composition.submodels.controlCommands.id,
        })
        log( 'sorting rules loaded', {
            rules: describeSortingRules( this.sortingRules ),
        })
    }

    // One look at the pick window at a time;
    // a request that arrives meanwhile is served right after
    async run() {
        for (;;) {
            this.isLookRequested = false
            await this.look()
            await this.waitForLookRequest()
        }
    }

    async look() {
        try {
            if ( this.haveSortingRulesChanged ) {
                await this.reloadSortingRules()
            }
            await this.dynamicSorting.handlePickWindow()
        } catch ( error ) {
            log( 'AAS API call failed', {
                error: error.message.slice( 0, 300 ),
            }, 'WARN' )
        }
    }

    async reloadSortingRules() {
        this.haveSortingRulesChanged = false
        this.dynamicSorting.sortingRules = await this.composition.getSortingRules()
        log( 'sorting rules loaded', {
            rules: describeSortingRules( this.dynamicSorting.sortingRules ),
        })
    }

    requestLook() {
        this.isLookRequested = true
        this.wakeUp?.()
    }

    // Until a look is requested (change event, retry) or the
    // reconciliation interval has passed
    waitForLookRequest() {
        if ( this.isLookRequested ) return
        return new Promise(( resolve ) => {
            const timer = setTimeout( resolve, this.config.reconciliationInterval )
            this.wakeUp = () => {
                clearTimeout( timer )
                resolve()
            }
        })
    }

    subscribeToChangeEvents() {
        // The cell controller and the edge gateways
        // publish their change events to the same broker
        const broker = mqtt.connect( this.config.eventBroker, {
            clientId: 'dynamic-sorting-application',
            protocolVersion: 5,
            reconnectPeriod: 2000,
        })

        broker.on( 'connect', () => {

            broker.subscribe( SUBMODEL_UPDATED_TOPIC, {
                qos: 1,
            })

            log( 'subscribed to change events', {
                broker: this.config.eventBroker,
            })

            this.requestLook()
        })

        broker.on( 'message', ( topic, payload ) => this.onChangeEvent( topic, payload ))

        broker.on( 'error', ( error ) =>
            log( 'event broker connection error', {
                error: error.message,
            }, 'WARN' )
        )
    }

    onChangeEvent( topic, payload ) {
        let submodelId

        try {
            submodelId = JSON.parse( payload.toString() ).data?.submodelId
        } catch {
            log( 'ERROR: message', { topic, payload: payload.toString() }, 'ERROR' )
            return
        }

        switch ( submodelId ) {

            case this.composition.submodels.sensedProperties.id:
                this.dynamicSorting.lastSensedEventAt = Date.now()
                break

            case this.composition.submodels.sortingRules.id:
                this.haveSortingRulesChanged = true
                break

            default:
                return
        }

        this.requestLook()
    }
}

const application = new DynamicSortingApplication( config )

const bye = () => application.stop()
process.once( 'SIGTERM', bye )
process.once( 'SIGINT', bye )

await application.start()

function describeSortingRules( sortingRules ) {
    return [ ...sortingRules ].map(([ colour, stockpile ]) =>
        `${ colour }:${ stockpile }` ).join( ' ' )
}

function getDuration( name, fallback ) {
    const text = process.env[ name ] || fallback
    const match = /^(\d+(?:\.\d+)?)(ms|s|m)$/.exec( text )
    if ( ! match ) throw new Error(`${ name } must be a duration such as 700ms or 2s, not "${ text }"`)
    return Number( match[ 1 ]) * { ms: 1, s: 1000, m: 60_000 }[ match[ 2 ]]
}
