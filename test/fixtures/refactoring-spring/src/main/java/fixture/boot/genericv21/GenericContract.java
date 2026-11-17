package fixture.boot.genericv21;

public interface GenericContract<T extends CharSequence> {
    T convert(T value, int unused);
}
