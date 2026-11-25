package groovyfixture;

public final class JavaEntry {
    public String badge(String name, int points) {
        return new GroovyBadge().label(name, points);
    }

    public static int score(int points) {
        return points * 2;
    }

    public static void main(String[] args) {
        System.out.println(new JavaEntry().badge("neo", 3));
    }
}
