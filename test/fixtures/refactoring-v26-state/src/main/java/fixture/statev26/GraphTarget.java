package fixture.statev26;

public final class GraphTarget {
    private int value;

    public GraphTarget(int seed) {
        this.value = seed;
    }

    public int advance(int amount) {
        this.value = this.value + amount;
        return this.value;
    }
}
