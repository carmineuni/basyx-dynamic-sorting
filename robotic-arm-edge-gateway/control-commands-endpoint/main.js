/**
 * Edge half of iDT_RA
 * Executed on the robotic arm edge gateway (E_RA): the proxy of
 * the arm. It hosts ControlCommands in this machine's repository, which
 * delegates every invocation of its DropAt Operation here (qualifier
 * invocationDelegation). The endpoint turns the invocation into a command for
 * the arm controller on the industrial communication gateway (ICG), waits for
 * the outcome and answers with an AAS OperationResult. It forwards; it takes
 * no decisions.
 *
 * Safety first: when the ICG cannot be reached, or the controller has
 * announced that it is offline, the command is refused at once instead of
 * being queued, so the arm never moves long after the request. The endpoint
 * listens on the loopback interface only: the other machines invoke DropAt
 * through the standard Submodel API of the repository.
 *
 *@PUBS: dynamic-sorting-cell/robotic-arm/control-commands
 *@SUBS: dynamic-sorting-cell/robotic-arm/control-command-results
 *@SUBS: dynamic-sorting-cell/robotic-arm/state
 */

import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import mqtt from 'mqtt'
import { EdgeSubmodel } from './edge-submodel.js'

const TOPICS = {
    controlCommands: 'dynamic-sorting-cell/robotic-arm/control-commands',
    commandResults: 'dynamic-sorting-cell/robotic-arm/control-command-results',
    state: 'dynamic-sorting-cell/robotic-arm/state',
}

const config = {
    icg: process.env.ICG_URL || 'mqtt://industrial-communication-gateway:1883',
    listenAddress: process.env.LISTEN_ADDRESS || '127.0.0.1:8080',
    repositoryUrl: process.env.REPOSITORY_URL || 'http://robotic-arm-edge-gateway:8092',
    plantRegistryUrl: process.env.PLANT_REGISTRY_URL || 'http://plant-server:8081',
    assetId: process.env.ASSET_ID || 'https://plant.example/assets/robotic-arm/RA-0001',
    file: process.env.SUBMODEL_FILE || '/usr/share/aas/control-commands-endpoint/control-commands-submodel.json',
    commandTimeout: getDuration( 'COMMAND_TIMEOUT', '20s' ),
    registrationInterval: getDuration( 'REGISTRATION_INTERVAL', '30s' ),
}

const CONTROL_COMMAND_PATHS = {
    dropAt: '/control-commands/drop-at',
}

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

class ControlCommandsEndpoint {

    pendingCommands = new Map() // commandIdentifier -> settles the wait for its result
    armState = 'unknown'

    constructor( config ) {
        this.config = config
        this.edgeSubmodel = new EdgeSubmodel({ ...config, log })

        this.icg = mqtt.connect( config.icg, {
            clientId: 'robotic-arm-edge-gateway',
            protocolVersion: 5,
            reconnectPeriod: 2000,
        })

        this.icg.on( 'connect', () => this.onConnect() )
        this.icg.on( 'message', ( topic, payload ) => this.onMessage( topic, payload ))
        this.icg.on( 'error', ( error ) => log( 'ICG connection error', {
            error: error.message,
        }, 'WARN' ))

        // The endpoint server
        // @SEE control-command-submodel / invocationDelegation
        this.server = createServer(( request, response ) => this.handleRequest( request, response ))
    }

    async start() {
        const [ listenHost, listenPort ] = this.config.listenAddress.split( ':' )
        this.server.listen( Number( listenPort ), listenHost, () =>
            log( 'waiting for delegated DropAt invocations', {
                address: this.config.listenAddress,
            }),
        )

        // (Unused) Only triggers a startup error,
        // e.g. if the submodel file cannot be read
        await this.edgeSubmodel.host()
    }

    stop() {
        this.server.close(() => this.icg.end(() => process.exit( 0 )))
    }

    onConnect() {

        log( 'connected to the ICG' )

        this.icg.subscribe([
            TOPICS.commandResults,
            TOPICS.state,
        ], {
            qos: 1
        })
    }

    onMessage( topic, payload ) {
        const message = parseMessage( payload )

        // Guard message
        if ( ! message ) return

        switch ( topic ) {

            case TOPICS.commandResults:

                log( 'Message: Command Result', message, 'DEBUG' )
                this.pendingCommands.get( message.commandIdentifier )?.( message )
                break

            case TOPICS.state:

                log( 'arm controller state', {
                    state: message.state,
                    previousState: this.armState,
                })

                this.armState = message.state

                if ( 'offline' === this.armState ) {
                    // The commands still waiting for an answer will never get one
                    for ( const settle of this.pendingCommands.values() ) {
                        settle({
                            outcome: 'controller-unreachable',
                            reason: 'the arm controller went offline before answering',
                        })
                    }
                }

                break
        }
    }

    async handleRequest( request, response ) {

        if ( 'POST' === request.method
            && CONTROL_COMMAND_PATHS.dropAt === request.url ) {

            const receivedAt = new Date().toISOString()
            let body = ''
            for await ( const chunk of request ) body += chunk

            const result = await this.dropAt( body )

            log( 'command finished', {
                outcome: result.outcome,
                reason: result.reason ?? '',
            })

            response
                .writeHead( 200, { 'Content-Type': 'application/json' })
                .end( JSON.stringify( this.toOperationResult( result, receivedAt )))

        } else {

            response.writeHead( 404 ).end()

        }
    }

    async dropAt( body ) {

        const input = this.parseDropAtInput( body )
        const refusal = this.findDropAtRefusal( input )

        if ( refusal ) {
            return refusal
        }

        const commandIdentifier = randomUUID()
        const result = this.waitForDropAtResult( commandIdentifier )
        const command = {
            commandIdentifier,
            command: 'dropAt',
            stockpile: input.Stockpile,
            objectIdentifier: input.ObjectIdentifier,
        }
        this.icg.publish( TOPICS.controlCommands, JSON.stringify( command ), {
            qos: 1,
        })
        log( 'dropAt forwarded to the arm controller', {
            object: input.ObjectIdentifier,
            stockpile: input.Stockpile,
        })
        try {
            return await result
        } finally {
            this.pendingCommands.delete( commandIdentifier )
        }
    }

    parseDropAtInput( body ) {
        try {
            // The repository sends the input variables of DropAt
            // as AAS OperationVariables.
            return Object.fromEntries( JSON.parse( body ).map(( variable ) => [
                variable.value.idShort,
                variable.value.value,
            ]))
        } catch {
            return undefined
        }
    }

    findDropAtRefusal( input ) {

        if ( ! input ) {
            return {
                outcome: 'invalid-command',
                reason: 'the request is not a list of operation variables',
            }
        }

        if ( 'left' !== input.Stockpile && 'right' !== input.Stockpile ) {
            return {
                outcome: 'invalid-command',
                reason: `unknown stockpile "${ input.Stockpile }": use left or right`,
            }
        }

        if ( ! this.icg.connected ) {
            return {
                outcome: 'controller-unreachable',
                reason: 'the arm controller cannot be reached (ICG down)',
            }
        }

        if ( 'offline' === this.armState ) {
            return {
                outcome: 'controller-unreachable',
                reason: 'the arm controller is offline',
            }
        }
    }

    waitForDropAtResult( commandIdentifier ) {
        return new Promise(( resolve ) => {
            const timeout = {
                outcome: 'timeout',
                reason: `no answer from the arm controller within ${ this.config.commandTimeout } ms`,
            }
            const timer = setTimeout( resolve, this.config.commandTimeout, timeout )
            this.pendingCommands.set( commandIdentifier, ( result ) => {
                clearTimeout( timer )
                resolve( result )
            })
        })
    }

    // The AAS OperationResult with the output variables of DropAt
    toOperationResult( result, commandReceivedAt ) {
        const isDropped = 'dropped' === result.outcome
        const toVariable = ( idShort, valueType, value ) => ({
            value: {
                modelType: 'Property',
                idShort,
                valueType,
                ...( value !== undefined && { value }),
            },
        })
        const operationResult = {
            executionState: isDropped
                ? 'Completed'
                : 'timeout' === result.outcome ? 'Timeout' : 'Failed',
            success: isDropped,
            outputArguments: [
                toVariable( 'ObjectDropped', 'xs:boolean', String( isDropped )),
                toVariable( 'Outcome', 'xs:string', result.outcome ),
                toVariable( 'CommandReceivedAt', 'xs:dateTime', commandReceivedAt ),
                toVariable( 'PickedAt', 'xs:dateTime', result.pickedAt ),
            ],
            ...( result.reason && {
                messages: [
                    {
                        messageType: 'Error',
                        code: `ROBOTIC-ARM-${ result.outcome }`,
                        text: result.reason,
                        timestamp: new Date().toISOString(),
                    },
                ],
            }),
        }
        log( 'Operation Result', operationResult, 'DEBUG' )
        return operationResult
    }
}

const endpoint = new ControlCommandsEndpoint( config )

const bye = () => endpoint.stop()
process.once( 'SIGTERM', bye )
process.once( 'SIGINT', bye )

await endpoint.start()

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
