package fixture.statev25;

public final class ParameterTarget {
    private int value;

    public ParameterTarget(int seed) { this.value = seed; }

    public int advance(int amount) {
        this.value = this.value + amount;
        return this.value;
    }
}
