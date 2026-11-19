package fixture.statev24;
public final class FieldSource {
    private final FieldTarget target;
    private final int ownerValue;
    private final boolean enabled;
    public FieldSource() { this(4); }
    public FieldSource(int owner) { this(owner, true); }
    public FieldSource(int owner, boolean active) { this.target = new FieldTarget(); this.ownerValue = owner; this.enabled = active; }
    public int fieldTransfer(int captured, int requested) { return target.advance(captured) + target.advance(requested); }
    public int run(int requested) { return fieldTransfer(this.ownerValue, requested); }
}
