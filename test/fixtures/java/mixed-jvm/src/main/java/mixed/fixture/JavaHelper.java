package mixed.fixture;

public class JavaHelper {
    public static String render(int number) {
        return "mixed-" + number;
    }

    public static String render(String text) {
        return "text-" + text;
    }

    public int getCount() {
        return 3;
    }
}
