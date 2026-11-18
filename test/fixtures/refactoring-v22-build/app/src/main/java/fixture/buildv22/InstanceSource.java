package fixture.buildv22;
public final class InstanceSource {
    public int total(InstanceTarget target, int value) { return target.base() + value; }
    public int run() { return total(new InstanceTarget(), 40); }
}
