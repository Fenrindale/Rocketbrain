package fixture.statev22;
public final class ParameterSource {
    public int parameterTotal(ParameterTarget target, int value) { return target.base() + value; }
    public int run() { return parameterTotal(new ParameterTarget(), 40); }
}
