package fixture.boot.genericv21;

import java.util.List;

public final class GenericMethods {
    public static <T extends Number & Comparable<T>> T bounded(T value, int unused) { return value; }
    public static String bounded(String value) { return value; }
    public static <T extends Number> int wildcard(List<? extends T> values, int unused) { return values.size(); }
}
