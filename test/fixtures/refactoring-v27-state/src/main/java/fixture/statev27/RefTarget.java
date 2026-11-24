package fixture.statev27;

public final class RefTarget {
    private int value;

    public RefTarget(int seed) {
        this.value = seed;
    }

    public int advance(int amount) {
        this.value = this.value + amount;
        return this.value;
    }

    public int current() {
        return this.value;
    }
}
