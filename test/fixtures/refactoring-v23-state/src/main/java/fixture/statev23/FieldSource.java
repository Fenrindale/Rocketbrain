package fixture.statev23;
public final class FieldSource {
    private final FieldTarget target;
    private int retainedState;
    public FieldSource(int retained) { this.target = new FieldTarget(2); this.retainedState = retained; }
    public int fieldAdvance(int value) { return target.advance(1) + target.advance(1) + value; }
    public int run() { return fieldAdvance(40); }
}
