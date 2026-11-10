/**
 * Sorts each package by its colour marking (The purpose of cDT_DS). This is the
 * only place in the plant where a decision is taken; the iDTs on the edge
 * gateways only read and forward. Every package gets a record with the time
 * of each step, from the belt's sensor to the gripper, so that the age of the
 * data behind each decision (staleness) and the delay added by each part of
 * the plant can be measured.
 */

import { SubmodelRepositoryClient } from 'basyx-typescript-sdk'
import { aasApiRequests, getData, toSubmodelRequest } from './composition.js'
import { log, printRecord } from './log.js'

const submodelRepository = new SubmodelRepositoryClient()

export class DynamicSorting {
    lastSensedEventAt = 0 // when the last change event of SensedProperties arrived
    packageCounters = { left: 0, right: 0, missed: 0, staleCommands: 0 }
    lastFinishedIdentifier = ''
    lastUnruledIdentifier = '' // the last package without a sorting rule, reported once
    requestsAtLastRecord = aasApiRequests.count
    recordsForSummary = []

    // The package being sorted: identifier, colour, stockpile, attempts, retryNotBefore and the
    // times (milliseconds) detectedAt, recordedAt, notifiedAt, readAt and decidedAt.
    currentPackage

    // retryIn(milliseconds) asks for another look at the pick window later.
    constructor({ submodels, sortingRules, packagesPerSummary, retryIn }) {
        Object.assign( this, {
            submodels,
            sortingRules,
            packagesPerSummary,
            retryIn,
        })
    }

    // Reads the pick window from iDT_CB and, for a new package,
    // decides its stockpile and commands iDT_RA.
    async handlePickWindow() {
        const currentObject = await this.getCurrentObject()
        const readAt = Date.now()

        if ( this.currentPackage && this.currentPackage.identifier !== currentObject.ObjectIdentifier ) {
            await this.finishPackage( this.currentPackage, 'abandoned', {}, readAt ) // it left while we were retrying
        }

        if ( ! currentObject.ObjectIdentifier || currentObject.ObjectIdentifier === this.lastFinishedIdentifier ) {
            return
        }

        // package
        const currentPackage = ( this.currentPackage ??= this.buildPackage( currentObject ))

        if ( readAt < currentPackage.retryNotBefore ) {
            return
        }

        currentPackage.readAt = readAt
        currentPackage.notifiedAt = this.computeNotifiedAt( currentPackage )
        currentPackage.stockpile = this.sortingRules.get( currentPackage.colour )

        if ( ! currentPackage.stockpile ) {
            return this.warnMissingSortingRule( currentPackage )
        }

        await this.commandDropAt( currentPackage )
    }

    async getCurrentObject() {
        return getData( await submodelRepository.getSubmodelElementByPathValueOnly({
            ...toSubmodelRequest( this.submodels.sensedProperties ),
            idShortPath: 'CurrentObject',
        }))
    }

    buildPackage( currentObject ) {
        return {
            identifier: currentObject.ObjectIdentifier,
            colour: currentObject.ObjectColour,
            attempts: 0,
            detectedAt: Date.parse( currentObject.DetectedAt ),
            recordedAt: Date.parse( currentObject.RecordedAt ),
            retryNotBefore: 0,
        }
    }

    computeNotifiedAt( currentPackage ) {
        return this.lastSensedEventAt >= currentPackage.recordedAt
            ? this.lastSensedEventAt
            : undefined
    }

    warnMissingSortingRule( currentPackage ) {
        if ( this.lastUnruledIdentifier !== currentPackage.identifier ) {
            log( 'no sorting rule for this colour: the package waits', {
                object: currentPackage.identifier,
                colour: currentPackage.colour,
            }, 'WARN' )
        }
        this.lastUnruledIdentifier = currentPackage.identifier
    }

    async commandDropAt( currentPackage ) {
        currentPackage.decidedAt = Date.now()
        currentPackage.attempts++

        log( 'decision', {
            object: currentPackage.identifier,
            colour: currentPackage.colour,
            stockpile: currentPackage.stockpile,
            stalenessMs: currentPackage.decidedAt - currentPackage.detectedAt,
            attempt: currentPackage.attempts,
        })

        const invocation = await this.invokeDropAt( currentPackage )
        const completedAt = Date.now()
        const result = invocation.success ? invocation.data : {}
        const outcome = String( result.outputArguments?.Outcome ?? 'no-answer' )
        switch ( outcome ) {
            case 'dropped':
                this.packageCounters[ 'left' === currentPackage.stockpile ? 'left' : 'right' ]++
                return this.finishPackage( currentPackage, outcome, result, completedAt )
            case 'missed':
            case 'no-package':
            case 'wrong-package':
                this.packageCounters[ 'missed' === outcome ? 'missed' : 'staleCommands' ]++
                return this.finishPackage( currentPackage, outcome, result, completedAt )
            case 'busy': // the arm is still placing the previous package
                return this.retryLater( currentPackage, 200 )
            default: {
                // Not executed (arm unreachable, timeout, refused):
                // try again while the package is in the pick window
                const delay = Math.min( 1000 * 2 ** currentPackage.attempts, 30_000 )

                log( 'DropAt not executed, retrying', {
                    object: currentPackage.identifier,
                    outcome,
                    reason: this.describeDropAtFailure( invocation, result ).slice( 0, 200 ),
                    inMs: delay,
                }, 'ERROR' )

                return this.retryLater( currentPackage, delay )
            }
        }
    }

    invokeDropAt( currentPackage ) {
        return submodelRepository.postInvokeOperationValueOnly({
            ...toSubmodelRequest( this.submodels.controlCommands ),
            idShortPath: 'DropAt',
            operationRequestValueOnly: {
                inputArguments: {
                    Stockpile: currentPackage.stockpile,
                    ObjectIdentifier: currentPackage.identifier,
                },
                clientTimeoutDuration: 'PT30S',
            },
        })
    }

    describeDropAtFailure( invocation, result ) {
        return invocation.success
            ? ( result.messages ?? [] ).map(( message ) => message.text ).join( '; ' )
            : JSON.stringify( invocation.error )
    }

    retryLater( currentPackage, milliseconds ) {
        currentPackage.retryNotBefore = Date.now() + milliseconds
        this.retryIn( milliseconds )
    }

    // Writes the record of a package and updates cDT_DS / OperationalData
    async finishPackage( currentPackage, outcome, result, completedAt ) {

        if ( 'abandoned' === outcome ) {
            this.packageCounters.missed++
        }

        const record = this.buildRecord( currentPackage, outcome, result, completedAt )

        this.requestsAtLastRecord = aasApiRequests.count
        this.currentPackage = undefined

        // A package seen again after it was abandoned is sorted again:
        // the twin had lost it, the cell had not
        if ( 'abandoned' !== outcome ) {
            this.lastFinishedIdentifier = currentPackage.identifier
        }

        printRecord( record )
        log( 'package handled', {
            object: currentPackage.identifier,
            outcome,
            stalenessMs: record.decisionStalenessMs,
            ...this.packageCounters,
        })

        this.summarise( record )

        await this.updateOperationalData( currentPackage, outcome, record )
    }

    buildRecord( currentPackage, outcome, result, completedAt ) {
        const commandReceivedAt = Date.parse( result.outputArguments?.CommandReceivedAt )
        const pickedAt = Date.parse( result.outputArguments?.PickedAt )
        return {
            record: 'package',
            objectIdentifier: currentPackage.identifier,
            objectColour: currentPackage.colour,
            stockpile: currentPackage.stockpile,
            outcome,
            attempts: currentPackage.attempts,
            detectedAt: toIso( currentPackage.detectedAt ),
            recordedAt: toIso( currentPackage.recordedAt ),
            notifiedAt: toIso( currentPackage.notifiedAt ),
            readAt: toIso( currentPackage.readAt ),
            decidedAt: toIso( currentPackage.decidedAt ),
            commandReceivedAt: toIso( commandReceivedAt ),
            pickedAt: toIso( pickedAt ),
            completedAt: toIso( completedAt ),
            proxyDelayMs: computeMillisecondsBetween( currentPackage.detectedAt, currentPackage.recordedAt ),
            notificationDelayMs: computeMillisecondsBetween( currentPackage.recordedAt, currentPackage.notifiedAt ),
            decisionStalenessMs: computeMillisecondsBetween( currentPackage.detectedAt, currentPackage.decidedAt ),
            commandDelayMs: computeMillisecondsBetween( currentPackage.decidedAt, commandReceivedAt ),
            endToEndMs: computeMillisecondsBetween( currentPackage.detectedAt, pickedAt ),
            aasApiRequests: aasApiRequests.count - this.requestsAtLastRecord,
        }
    }

    async updateOperationalData( currentPackage, outcome, record ) {
        const operationalData = {
            State: 'Running',
            Packages: {
                SortedToLeftStockpile: this.packageCounters.left,
                SortedToRightStockpile: this.packageCounters.right,
                Missed: this.packageCounters.missed,
                StaleCommands: this.packageCounters.staleCommands,
            },
            LastPackage: {
                ObjectIdentifier: currentPackage.identifier,
                Outcome: outcome,
                DecisionStalenessMilliseconds: record.decisionStalenessMs ?? null,
                EndToEndMilliseconds: record.endToEndMs ?? null,
            },
            AasApiRequests: aasApiRequests.count + 1, // this update included
        }
        const updated = await submodelRepository.patchSubmodelByIdValueOnly({
            ...toSubmodelRequest( this.submodels.operationalData ),
            body: operationalData,
        })

        if ( ! updated.success ) {
            log( 'OperationalData not updated', {
                status: updated.statusCode,
            }, 'WARN' )
        }
    }

    // Every packagesPerSummary packages:
    // the distribution of each delay and the count of each outcome.
    summarise( record ) {

        this.recordsForSummary.push( record )

        if ( this.recordsForSummary.length < this.packagesPerSummary ) {
            return
        }

        const summary = this.buildSummary( this.recordsForSummary.splice( 0 ))
        const staleness = summary.decisionStalenessMs

        printRecord( summary )
        log( 'summary', {
            packages: summary.packages,
            ...summary.outcomes,
            stalenessMedianMs: staleness?.median,
            stalenessP95Ms: staleness?.p95,
        })
    }

    buildSummary( records ) {
        return {
            record: 'summary',
            packages: records.length,
            firstDetectedAt: records[ 0 ].detectedAt,
            lastCompletedAt: records.at( -1 ).completedAt,
            outcomes: countOutcomes( records ),
            proxyDelayMs: computeDistribution( records, 'proxyDelayMs' ),
            notificationDelayMs: computeDistribution( records, 'notificationDelayMs' ),
            decisionStalenessMs: computeDistribution( records, 'decisionStalenessMs' ),
            commandDelayMs: computeDistribution( records, 'commandDelayMs' ),
            endToEndMs: computeDistribution( records, 'endToEndMs' ),
            aasApiRequestsPerPackage: Math.round(( records.reduce(( sum, record ) =>
                sum + record.aasApiRequests, 0 ) / records.length ) * 10 ) / 10,
        }
    }

    async setState( state ) {
        const body = {
            State: state,
        }
        getData( await submodelRepository.patchSubmodelByIdValueOnly({
            ...toSubmodelRequest( this.submodels.operationalData ),
            body,
        }))
    }
}

function countOutcomes( records ) {
    const outcomes = {}
    for ( const record of records ) {
        outcomes[ record.outcome ] = ( outcomes[ record.outcome ] ?? 0 ) + 1
    }
    return outcomes
}

function computeDistribution( records, field ) {
    const values = records.map(( record ) => record[ field ]).filter(( value ) => 'number' === typeof value ).sort(( a, b ) => a - b )
    const rank = ( q ) => values[ Math.max( Math.ceil( q * values.length ) - 1, 0 )] // nearest rank
    return values.length
        ? {
            packages: values.length,
            median: rank( 0.5 ),
            p95: rank( 0.95 ),
            max: values.at( -1 ),
          }
        : undefined
}

function toIso( time ) {
    return Number.isFinite( time )
        ? new Date( time ).toISOString()
        : undefined
}

function computeMillisecondsBetween( from, to ) {
    return Number.isFinite( from ) && Number.isFinite( to )
        ? to - from
        : undefined
}
