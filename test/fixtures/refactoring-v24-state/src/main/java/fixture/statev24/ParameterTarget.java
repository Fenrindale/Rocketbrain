package fixture.statev24;
public final class ParameterTarget {
    private int value;
    private final int initial;
    public ParameterTarget() { this(2); }
    public ParameterTarget(int seed) { this.initial = seed; this.value = seed; }
    public int advance(int amount) { this.value = this.value + amount; return this.value; }
}
