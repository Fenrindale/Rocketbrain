package fixture.boot;

/** Plain source contract used by the owned refactoring checks. */
public final class RefactoringCalculator {
    private final String label;
    private final int count;

    public RefactoringCalculator(String label, int count, int unused) {
        this.label = label;
        this.count = count;
    }

    public String result() { return label + count; }

    public static String formatPair(String label, int count, int unused) {
        return label + count;
    }

    public static String callStatic() { return formatPair("value:", 3, 7); }
    public static String callConstructor() { return new RefactoringCalculator("ctor:", 4, 8).result(); }
    public static void main(String[] args) { System.out.println(callStatic() + ";" + callConstructor()); }
}
