/**
 * Composition of cDT_DS from the iDTs of the cell's parts
 *
 * The application knows only the global asset ID of the cell.
 * It finds the shells through the Discovery service and the AAS Registry, the
 * parts of the cell through the HierarchicalStructures submodel (IDTA 02011),
 * and each submodel and its endpoint through the Submodel Registry, by
 * semantic ID. Where a submodel is hosted, on the plant server, on the cell
 * controller or on an edge gateway, is read from its descriptor.
 */

import {
    AasDiscoveryClient,
    AasService,
    Configuration,
    SubmodelRegistryClient,
    SubmodelRepositoryClient,
    convertCoreSubmodelToApiSubmodel,
    extractEndpointHref,
} from 'basyx-typescript-sdk'
import { log } from './log.js'

const SEMANTIC_NAMESPACE = 'https://plant.example/semantics/dynamic-sorting'
const SEMANTIC_IDS = {
    hierarchicalStructures: 'https://admin-shell.io/idta/HierarchicalStructures/1/1/Submodel',
    entryNode: 'https://admin-shell.io/idta/HierarchicalStructures/EntryNode/1/0',
    node: 'https://admin-shell.io/idta/HierarchicalStructures/Node/1/0',
    sortingRules: `${ SEMANTIC_NAMESPACE }/SortingRules/1/0`,
    sortingRule: `${ SEMANTIC_NAMESPACE }/SortingRule/1/0`,
    objectColour: `${ SEMANTIC_NAMESPACE }/ObjectColour/1/0`,
    stockpile: `${ SEMANTIC_NAMESPACE }/Stockpile/1/0`,
    operationalData: `${ SEMANTIC_NAMESPACE }/OperationalData/1/0`,
    sensedProperties: `${ SEMANTIC_NAMESPACE }/SensedProperties/1/0`,
    controlCommands: `${ SEMANTIC_NAMESPACE }/ControlCommands/1/0`,
}

// Every request to the AAS API goes through this fetch, so that it is counted.
export const aasApiRequests = {
    count: 0,
}
const countingFetch = ( input, init ) => {
    aasApiRequests.count++
    return fetch( input, init )
}

const createConfiguration = ( basePath ) => new Configuration({
    basePath,
    fetchApi: countingFetch,
})

export class Composition {

    constructor( parts, submodels ) {
        this.parts = parts
        this.submodels = submodels
    }

    // The submodels of both cDT_DS and the parts of the cell, each as
    // { id, semanticId, configuration }: where it can be reached.
    static async compose( plantRegistryUrl, cellAssetId ) {
        const registry = createConfiguration( plantRegistryUrl )
        const cellSubmodels = await getSubmodelsOfAsset( registry, cellAssetId )
        const hierarchicalStructures = await getSubmodel( findBySemanticId( cellSubmodels, SEMANTIC_IDS.hierarchicalStructures ))
        const entryNode = filterBySemanticId( hierarchicalStructures.submodelElements, SEMANTIC_IDS.entryNode )[ 0 ]
        if ( ! entryNode ) {
            throw new Error( 'HierarchicalStructures has no EntryNode' )
        }
        const parts = filterBySemanticId( entryNode.statements, SEMANTIC_IDS.node )
            .map(( node ) => node.globalAssetId )
        const partSubmodels = ( await Promise.all( parts.map(( part ) =>
            getSubmodelsOfAsset( registry, part )))).flat()

        const composition = new Composition( parts, {
            sortingRules: findBySemanticId( cellSubmodels, SEMANTIC_IDS.sortingRules ),
            operationalData: findBySemanticId( cellSubmodels, SEMANTIC_IDS.operationalData ),
            sensedProperties: findBySemanticId( partSubmodels, SEMANTIC_IDS.sensedProperties ), // iDT_CB, on the conveyor belt edge gateway
            controlCommands: findBySemanticId( partSubmodels, SEMANTIC_IDS.controlCommands ), // iDT_RA, on the robotic arm edge gateway
        })

        log( 'Composed', composition.listEndpoints(), 'DEBUG' )

        return composition
    }

    // Where each submodel is hosted
    listEndpoints() {
        const endpoints = {}
        for ( const [ name, submodel ] of Object.entries( this.submodels )) {
            endpoints[ name ] = submodel.configuration.basePath
        }
        return endpoints
    }

    // Colour marking -> stockpile, from cDT_DS / SortingRules.
    async getSortingRules() {
        const sortingRules = new Map()
        for ( const sortingRule of filterBySemanticId(( await getSubmodel( this.submodels.sortingRules ))
            .submodelElements, SEMANTIC_IDS.sortingRule )) {
            const colour = filterBySemanticId( sortingRule.value, SEMANTIC_IDS.objectColour )[ 0 ]?.value
            const stockpile = filterBySemanticId( sortingRule.value, SEMANTIC_IDS.stockpile )[ 0 ]?.value
            if ( colour && stockpile ) sortingRules.set( colour, stockpile )
        }
        if ( 0 === sortingRules.size ) {
            throw new Error( 'SortingRules contains no rule' )
        }

        log( 'Rules', { rules: Object.fromEntries( sortingRules ) }, 'DEBUG' )
        return sortingRules
    }
}

async function getSubmodelsOfAsset( registry, assetId ) {

    // The shells are read from the endpoints in their descriptors.
    const aasService = new AasService({
        aasRegistryConfig: registry,
        aasRepositoryConfig: registry,
        endpointConfiguration: () => createConfiguration( '' ),
    })

    const submodels = []
    for ( const aasIdentifier of await getShellIdentifiers( registry, assetId )) {
        const { shell } = getData( await aasService.getAasById({
            aasIdentifier,
        }))
        for ( const reference of shell.submodels ?? [] ) {
            submodels.push( await getSubmodelEndpoint( registry, reference.keys.at( -1 ).value ))
        }
    }
    return submodels
}

async function getShellIdentifiers( registry, assetId ) {
    const assetLink = [{
        name: 'globalAssetId',
        value: assetId,
    }]
    const shells = getData( await new AasDiscoveryClient().searchAllAssetAdministrationShellIdsByAssetLink({
        configuration: registry,
        assetLink,
    }))

    if ( 0 === shells.result.length ) {
        throw new Error( `no shell registered for asset ${ assetId }` )
    }
    return shells.result
}

// The submodel as { id, semanticId, configuration }, from its descriptor
async function getSubmodelEndpoint( registry, id ) {
    const descriptor = getData(
        await new SubmodelRegistryClient().getSubmodelDescriptorById({
            configuration: registry,
            submodelIdentifier: id,
        }),
        `submodel ${ id } is not registered (yet)`
    )
    const href = extractEndpointHref( descriptor, 'SUBMODEL-3.0' ) // any SUBMODEL-3.x endpoint
    if ( ! href ) {
        throw new Error( `submodel ${ id } has no SUBMODEL-3.x endpoint` )
    }
    return {
        id,
        semanticId: descriptor.semanticId?.keys[ 0 ]?.value ?? '',
        configuration: createConfiguration(
            href.slice( 0, href.lastIndexOf( '/submodels/' ))),
    }
}

// A whole submodel as AAS JSON.
async function getSubmodel( submodel ) {
    return convertCoreSubmodelToApiSubmodel( getData(
        await new SubmodelRepositoryClient().getSubmodelById(
            toSubmodelRequest( submodel )))
    )
}

export const toSubmodelRequest = ( submodel ) => ({
    configuration: submodel.configuration,
    submodelIdentifier: submodel.id,
})

function findBySemanticId( submodels, semanticId ) {
    const submodel = submodels.find(( candidate ) =>
        candidate.semanticId === semanticId )
    if ( ! submodel ) {
        throw new Error( `no submodel with semantic ID ${ semanticId }` )
    }
    return submodel
}

function filterBySemanticId( elements, semanticId ) {
    return ( elements ?? [] ).filter(( element ) =>
        element.semanticId?.keys?.[ 0 ]?.value === semanticId
    )
}

// The data of a successful SDK call, or an error with the HTTP status.
export function getData( result, context = '' ) {

    if ( result.success ) {
        return result.data
    }

    const error = JSON.stringify( result.error ).slice( 0, 300 )
    throw new Error( `${ context } HTTP ${ result.statusCode ?? '-' } ${ error }`.trim() )
}
