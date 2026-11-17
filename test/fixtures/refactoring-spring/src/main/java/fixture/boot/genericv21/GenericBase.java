package fixture.boot.genericv21;

public class GenericBase<T extends CharSequence> implements GenericContract<T> {
    @Override
    public T convert(T value, int unused) { return value; }
}
