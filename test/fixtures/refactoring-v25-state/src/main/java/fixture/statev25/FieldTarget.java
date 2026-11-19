package fixture.statev25;

public final class FieldTarget {
    private int value;

    public FieldTarget(int seed) { this.value = seed; }

    public int advance(int amount) {
        this.value = this.value + amount;
        return this.value;
    }
}
