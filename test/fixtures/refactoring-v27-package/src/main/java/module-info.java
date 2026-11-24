module fixture.packagev27 {
    // Keep this service consumer and both providers in the same module.
    uses fixture.packagev27.payload.PackageValue;
    provides fixture.packagev27.payload.PackageValue
        with fixture.packagev27.payload.FactoryProvider, // created through provider()
             fixture.packagev27.peers.DirectValue;
}
