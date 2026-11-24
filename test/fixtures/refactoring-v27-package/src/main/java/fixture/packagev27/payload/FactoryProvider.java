package fixture.packagev27.payload;

public final class FactoryProvider {
    private FactoryProvider() {}
    public static PackageValue provider() {
        return new FactoryValue();
    }
}
