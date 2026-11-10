/**
 * Output of the dynamic sorting application
 * - the log, for people, on standard error
 * - the records, one JSON object per line, on standard output
 */

const COLOURS = {
    blue: '\x1b[34m',       // blue
    cyan: '\x1b[36m',       // cyan
    INFO: '\x1b[32m',       // green
    DEBUG: '\x1b[90m',      // grey
    magenta: '\x1b[35m',    // magenta
    ERROR: '\x1b[31m',      // red
    WARN: '\x1b[33m',       // yellow
    bold: '\x1b[1m',
    reset: '\x1b[0m',
}

export function log( message, fields = {}, level = 'INFO' ) {
    const details = Object.entries( fields ).map(([ key, value ]) =>
        ` ${ key }=${ 'object' === typeof value ? JSON.stringify( value ) : value }` ).join( '' )

    console.error( `${ COLOURS[ level ] } time=${ Date.now() } level=${ level } msg="${ message }"${ details } ${ COLOURS.reset }` )
}

export function printRecord( record ) {
    console.log( JSON.stringify( record ))
}
