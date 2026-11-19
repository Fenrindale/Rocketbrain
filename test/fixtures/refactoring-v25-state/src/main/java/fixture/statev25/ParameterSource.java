package fixture.statev25;

public final class ParameterSource {
    private final ParameterTarget stored;
    private final ParameterTarget storedAlias;

    public ParameterSource() {
        this.stored = new ParameterTarget(9);
        this.storedAlias = this.stored;
    }

    public int measureReferences(ParameterTarget target, ParameterTarget left, ParameterTarget right, int delta) {
        return (left != right ? 1000 : 0)
                + target.advance(delta) * 100 + left.advance(1) * 10 + right.advance(2);
    }

    public int run(int delta) { return measureReferences(new ParameterTarget(2), this.stored, this.storedAlias, delta); }
}
