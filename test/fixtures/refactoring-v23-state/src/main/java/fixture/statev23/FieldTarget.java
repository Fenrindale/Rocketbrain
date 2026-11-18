package fixture.statev23;
public final class FieldTarget {
    private int value;
    private final int initial;
    public FieldTarget(int seed) { this.initial = seed; this.value = seed; }
    public int advance(int amount) { this.value = this.value + amount; return this.value; }
    public int base() { return this.value; }
}
