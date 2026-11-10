/**
 * Simulated Robotic Arm (RA)
 * - its controller
 *
 * It receives control commands from the industrial communication gatewa
 * (ICG), executes one at a time and reports the outcome:
 *
 * dropAt( stockpile, objectIdentifier ):
 *   Reach the package in the pick window, grasp it and release it over the
 *   left or the right stockpile
 *
 * As soon as the gripper has closed on the package, the controller publishes
 * "object picked", so that the belt can bring the next package.
 *
 *@PUBS: robotic-arm/object-picked
 *@PUBS: robotic-arm/control-command-results
 *@PUBS: dynamic-sorting-cell/robotic-arm/state
 *@SUBS: dynamic-sorting-cell/conveyor-belt/pick-window
 *@SUBS: robotic-arm/control-commands
 */

import { setTimeout as sleep } from 'node:timers/promises'
import mqtt from 'mqtt'

const TOPICS = {
    pickWindow: 'dynamic-sorting-cell/conveyor-belt/pick-window',
    controlCommands: 'dynamic-sorting-cell/robotic-arm/control-commands',
    commandResults: 'dynamic-sorting-cell/robotic-arm/control-command-results',
    objectPicked: 'dynamic-sorting-cell/robotic-arm/object-picked',
    state: 'dynamic-sorting-cell/robotic-arm/state',
}

const config = {
    icg: process.env.ICG_URL || 'mqtt://industrial-communication-gateway:1883',
    reachTime: getDuration( 'REACH_TIME', '700ms' ),
    placeTime: getDuration( 'PLACE_TIME', '700ms' ),
}

const OFFLINE_STATE = JSON.stringify({ state: 'offline' })

const COLOURS = {
    blue: '\x1b[34m',       // blue
    cyan: '\x1b[36m',       // cyan
    green: '\x1b[32m',      // green
    DEBUG: '\x1b[90m',      // grey
    INFO: '\x1b[95m',       // magenta
    ERROR: '\x1b[31m',      // red
    WARN: '\x1b[33m',       // yellow
    bold: '\x1b[1m',
    reset: '\x1b[0m',
}

class RoboticArmController {

    objectInPickWindow = ''
    isBusy = false

    constructor( config ) {
        this.config = config

        this.icg = mqtt.connect( config.icg, {
            clientId: 'robotic-arm-controller',
            protocolVersion: 5,
            reconnectPeriod: 2000,
            will: {
                topic: TOPICS.state,
                payload: Buffer.from( OFFLINE_STATE ),
                qos: 1,
                retain: true,
            },
        })

        this.icg.on( 'connect', () => this.onConnect() )
        this.icg.on( 'message', ( topic, payload ) => this.onMessage( topic, payload ))
        this.icg.on( 'error', ( error ) => log( 'ICG connection error', {
            error: error.message
        }, 'WARN' ))

        log( 'robotic arm controller started', {
            icg: config.icg,
            reachTimeMs: config.reachTime,
            placeTimeMs: config.placeTime,
        })
    }

    stop() {
        this.icg.publish( TOPICS.state, OFFLINE_STATE, {
            qos: 1,
            retain: true,
        }, () => this.icg.end(() => process.exit( 0 )))
    }

    onConnect() {

        log( 'connected to the ICG' )

        this.icg.subscribe([
            TOPICS.pickWindow,
            TOPICS.controlCommands,
        ], {
            qos: 1,
        })

        this.setState( this.isBusy ? 'busy' : 'idle' )
    }

    onMessage( topic, payload ) {
        try {

            const message = JSON.parse( payload.toString() )

            log( 'message', {
                topic,
                message,
            }, 'DEBUG' )

            switch ( topic ) {

                case TOPICS.pickWindow:
                    this.objectInPickWindow = message.objectIdentifier
                    break

                default:
                    void this.executeCommand( message )
                    break
            }
        } catch {

            log( 'ERROR on message', { topic, message: payload.toString() }, 'DEBUG' )

        }
    }

    async executeCommand( command ) {

        const refusal = this.findRefusal( command )
        if ( refusal ) {

            log( 'command refused', {
                object: command.objectIdentifier,
                ...refusal,
            }, 'WARN' )

            return this.reportResult( command, refusal )
        }

        const target = this.objectInPickWindow

        this.setState( 'busy' )
        log( 'reaching for the package', {
            object: target,
            stockpile: command.stockpile,
        })

        await sleep( this.config.reachTime )

        if ( this.objectInPickWindow !== target ) {
            return this.reportMissed( target, command )
        }

        const pickedAt = this.executePick( target, command )
        await sleep( this.config.placeTime )
        this.setState( 'idle' )
        this.executeDrop( target, command, pickedAt )
    }

    // Returns when the gripper closed on the package
    executePick( target, command ) {
        const pickedAt = new Date().toISOString()

        this.publish( TOPICS.objectPicked, {
            objectIdentifier: target,
            pickedAt,
        })

        log( 'package picked, moving to the stockpile', {
            object: target,
            stockpile: command.stockpile,
        })

        return pickedAt
    }

    executeDrop( target, command, pickedAt ) {

        this.reportResult( command, {
            outcome: 'dropped',
            pickedAt,
        })

        log( 'package dropped', {
            object: target,
            stockpile: command.stockpile,
        })
    }

    reportMissed( target, command ) {

        this.setState( 'idle' )
        log( 'Missed: the package left the pick window before the gripper reached it', {
            object: target,
        }, 'WARN' )

        this.reportResult( command, {
            outcome: 'missed',
            reason: 'the package left the pick window before the gripper reached it',
        })
    }

    setState( state ) {
        this.isBusy = 'busy' === state
        this.publish( TOPICS.state, {
            state,
        }, true )
    }

    findRefusal( command ) {

        if ( 'dropAt' !== command.command || ! [ 'left', 'right' ].includes( command.stockpile )) {
            return {
                outcome: 'invalid-command',
                reason: `unknown command ${ command.command }(${ command.stockpile })`,
            }
        }
        if ( this.isBusy ) {
            return {
                outcome: 'busy',
                reason: 'the arm is busy with another command',
            }
        }
        if ( ! this.objectInPickWindow ) {
            return {
                outcome: 'no-package',
                reason: 'no package in the pick window',
            }
        }
        if ( command.objectIdentifier !== this.objectInPickWindow ) {
            return {
                outcome: 'wrong-package',
                reason: `expected ${ command.objectIdentifier }, found ${ this.objectInPickWindow }`,
            }
        }
    }

    reportResult( command, result ) {
        const message = {
            commandIdentifier: command.commandIdentifier,
            objectIdentifier: command.objectIdentifier,
            ...result,
        }
        this.publish( TOPICS.commandResults, message )
    }

    publish( topic, message, retain = false ) {

        const icgMessage = JSON.stringify( message )

        if ( this.icg.connected ) {

            log( 'Publish', {
                topic,
                message: icgMessage,
            }, 'DEBUG' )

            this.icg.publish( topic, icgMessage, {
                qos: 1,
                retain,
            })

        } else {

            log( 'WARN: Publish disconnected', {
                topic,
                message: icgMessage,
            }, 'WARN' )

        }
    }
}

const roboticArm = new RoboticArmController( config )

const bye = () => roboticArm.stop()
process.once( 'SIGTERM', bye )
process.once( 'SIGINT', bye )

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
