package fixture.statev22;
public final class FieldSource {
    private final FieldTarget target = new FieldTarget();
    private final int retainedState = 7;
    public int fieldTotal(int value) { return target.base() + value; }
    public int run() { return fieldTotal(40); }
}
