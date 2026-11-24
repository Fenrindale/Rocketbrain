package fixture.packagev27.client;

import fixture.packagev27.payload.PackageValue;

public final class ModuleProbe {
    public static void main(String[] args) {
        if (!ModuleProbe.class.getModule().isNamed() || !ModuleProbe.class.getModule().getName().equals("fixture.packagev27")) {
            throw new IllegalStateException("Run this fixture on its named module path.");
        }
        var values = java.util.ServiceLoader.load(java.lang.ModuleLayer.boot(), PackageValue.class)
            .stream().map(provider -> provider.get().value()).toList();
        System.out.println(values);
    }
}
