package fixture.boot.genericv21;

import java.util.List;
import java.util.function.BiFunction;
import java.util.function.Function;

public final class GenericConflicts implements Function<String, String> {
    public static <T> int erased(List<T> values, int unused) { return values.size(); }
    public static int erased(List<String> values) { return values.size(); }
    public static <T> T indirect(T value, int unused) { return value; }
    public static BiFunction<String, Integer, String> indirectCaller() { return GenericConflicts::indirect; }
    public String clone(int unused) { return "kept"; }
    @Override
    public String apply(String value) { return value; }
}
