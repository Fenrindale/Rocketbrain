package fixture.statev25;

public final class FieldSource {
    private final FieldTarget primary = new FieldTarget(2);
    private final FieldTarget mirror = primary;
    private final FieldTarget other;
    private final FieldTarget forward;
    private final int bias;

    public FieldSource() { this(10); }

    public FieldSource(int bias) {
        this.other = new FieldTarget(10);
        this.forward = this.mirror;
        this.bias = bias;
    }

    public int routeReferences(FieldTarget left, FieldTarget right, int delta, int bias) {
        return (left == right ? 1000 : 2000)
                + primary.advance(delta) * 100 + left.advance(1) * 10 + right.advance(2) + bias;
    }

    public int runShared(int delta) { return routeReferences(this.mirror, this.forward, delta, this.bias); }
    public int runDistinct(int delta) { return routeReferences(this.mirror, this.other, delta, this.bias); }
}
