package fixture.boot.genericv21;

public final class GenericChild extends GenericBase<String> {
    @Override
    public String convert(String value, int unused) { return value; }
}
