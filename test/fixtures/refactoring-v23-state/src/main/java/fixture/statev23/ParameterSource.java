package fixture.statev23;
public final class ParameterSource {
    private final int retainedState;
    public ParameterSource(int retained) { this.retainedState = retained; }
    public int parameterAdvance(ParameterTarget target, int value) { return target.advance(1) + target.advance(2) + value; }
    public int run() { return parameterAdvance(new ParameterTarget(2), 40); }
}
