package fixture.statev24;
public final class ParameterSource {
    private final int ownerValue;
    private final boolean enabled;
    public ParameterSource() { this(6); }
    public ParameterSource(int owner) { this(owner, true); }
    public ParameterSource(int owner, boolean active) { this.ownerValue = owner; this.enabled = active; }
    public int parameterTransfer(ParameterTarget target, int captured, int requested) { return target.advance(captured) + target.advance(requested); }
    public int run(int ownerValue) { return parameterTransfer(new ParameterTarget(), this.ownerValue, ownerValue); }
}
