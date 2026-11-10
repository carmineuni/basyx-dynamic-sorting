// The edge half of a twin: the live submodel
// is loaded from a file, hosted in this machine's BaSyx Submodel Repository
// (which checks it against the AAS metamodel) and registered in the plant's
// registry, both as a submodel and under the shell of its asset. A submodel
// the repository already hosts is kept as it is: writing the file again would
// show its initial values to the other twins until the next update.
// The registration is repeated every REGISTRATION_INTERVAL, so that the
// registry heals after a reset. The edge gateways and the cell controller
// share this file.
import { readFile } from 'node:fs/promises'
import { setTimeout as sleep } from 'node:timers/promises'
import {
    AasDiscoveryClient,
    AasRegistryClient,
    Configuration,
    SubmodelRegistryClient,
    SubmodelRepositoryClient,
    base64Encode,
    convertApiSubmodelToCoreSubmodel,
    submodelDescriptorFromJsonable,
} from 'basyx-typescript-sdk'

export class EdgeSubmodel {

    isRegistered = false

    // options: file (the submodel as AAS JSON), repositoryUrl (this machine's
    // repository, as the other machines reach it), plantRegistryUrl (discovery
    // service and registries of the plant), assetId (global asset ID of the
    // machine the submodel belongs to), registrationInterval and log.
    constructor( options ) {
        this.options = options
        this.localRepository = new Configuration({ basePath: options.repositoryUrl })
        this.registry = new Configuration({ basePath: options.plantRegistryUrl })
    }

    // Returns the identifier of the submodel.
    async host() {
        const json = JSON.parse( await readFile( this.options.file, 'utf8' ))
        this.submodel = convertApiSubmodelToCoreSubmodel( json )
        this.descriptor = this.buildDescriptor( json )

        await this.createInLocalRepository()
        void this.keepRegisteredInPlantRegistry()

        return this.submodel.id
    }

    async createInLocalRepository() {
        for (;;) {
            const created = await new SubmodelRepositoryClient().putSubmodelById({
                configuration: this.localRepository,
                submodelIdentifier: this.submodel.id,
                submodel: this.submodel,
                ifNoneMatch: '*', // create only
            })

            if ( created.success || created.preconditionFailed ) {
                const message = created.success
                    ? 'submodel published in the local repository'
                    : 'submodel already hosted in the local repository'
                this.options.log( message, {
                    submodel: this.submodel.idShort,
                })
                return
            }

            this.options.log( 'the local repository does not accept the submodel yet', {
                error: describeError( created ),
            }, 'WARN' )
            await sleep( 2000 )
        }
    }

    async keepRegisteredInPlantRegistry() {
        for (;;) {
            try {
                await this.registerInPlantRegistry()
                if ( ! this.isRegistered ) {
                    this.options.log( 'submodel registered in the plant registry', {
                        submodel: this.submodel.idShort,
                        endpoint: this.options.repositoryUrl,
                    })
                }
                this.isRegistered = true
            } catch ( error ) {
                this.options.log( 'registration in the plant registry failed, retrying', {
                    error: error.message,
                }, 'WARN' )
                this.isRegistered = false
            }
            await sleep( this.isRegistered ? this.options.registrationInterval : 5000 )
        }
    }

    async registerInPlantRegistry() {
        await this.putSubmodelDescriptor()
        for ( const aasIdentifier of await this.getShellIdentifiers() ) {
            await this.putSubmodelDescriptorUnderShell( aasIdentifier )
        }
    }

    async putSubmodelDescriptor() {
        const registered = await new SubmodelRegistryClient().putSubmodelDescriptorById({
            configuration: this.registry,
            submodelIdentifier: this.submodel.id,
            submodelDescriptor: this.descriptor,
        })
        if ( ! registered.success ) throw new Error( `submodel registry: ${ describeError( registered ) }` )
    }

    async getShellIdentifiers() {
        const shells = await new AasDiscoveryClient().searchAllAssetAdministrationShellIdsByAssetLink({
            configuration: this.registry,
            assetLink: [{ name: 'globalAssetId', value: this.options.assetId }],
        })
        if ( ! shells.success ) throw new Error( `discovery: ${ describeError( shells ) }` )
        return shells.data.result
    }

    async putSubmodelDescriptorUnderShell( aasIdentifier ) {
        const registered = await new AasRegistryClient().putSubmodelDescriptorByIdThroughSuperpath({
            configuration: this.registry,
            aasIdentifier,
            submodelIdentifier: this.submodel.id,
            submodelDescriptor: this.descriptor,
        })
        if ( ! registered.success ) throw new Error( `AAS registry: ${ describeError( registered ) }` )
    }

    buildDescriptor( json ) {
        return submodelDescriptorFromJsonable({
            id: json.id,
            idShort: json.idShort,
            semanticId: json.semanticId,
            endpoints: [
                {
                    interface: 'SUBMODEL-3.2',
                    protocolInformation: {
                        href: `${ this.options.repositoryUrl }/submodels/${ base64Encode( json.id ) }`,
                    },
                },
            ],
        }).mustValue()
    }
}

export function describeError( result ) {
    return `HTTP ${ result.statusCode ?? '-' } ${ JSON.stringify( result.error ?? '' ).slice( 0, 300 ) }`
}
