package fixture.statev28;

public final class RefTarget {
    private int state;

    public RefTarget(int initial) {
        this.state = initial;
    }

    public int advance(int delta) {
        state = state + delta;
        return state;
    }

    public int current() {
        return state;
    }
}
