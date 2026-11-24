package fixture.statev26;

public final class GraphLeaf {
    private final GraphTarget primary;
    private final GraphTarget alternate;

    public GraphLeaf(GraphTarget primary, GraphTarget alternate) {
        this.primary = primary;
        this.alternate = alternate;
    }

    public GraphTarget head() {
        return this.primary;
    }

    public GraphTarget tail() {
        return this.alternate;
    }
}
