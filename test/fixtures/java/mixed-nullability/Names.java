package mixed.rename.contract;

import java.util.Arrays;
import java.util.List;
import org.jspecify.annotations.NullMarked;
import org.jspecify.annotations.NullUnmarked;
import org.jspecify.annotations.Nullable;

@NullMarked
public final class Names {
    public static @Nullable String maybe() { return null; }
    public static String demand(String value) { return value; }
    public static <T extends Object> T checked(T value) { return value; }
    public static List<@Nullable String> items() { return Arrays.asList((String) null); }
    @NullUnmarked public static String platform() { return "ok"; }

    public static String choose(String text) { return text; }
    public static int choose(int value) { return value; }
}
