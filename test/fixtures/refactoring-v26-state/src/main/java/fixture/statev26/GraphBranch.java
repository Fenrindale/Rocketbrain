package fixture.statev26;

public final class GraphBranch {
    private final GraphLeaf left;
    private final GraphLeaf right;

    public GraphBranch(GraphLeaf left, GraphLeaf right) {
        this.left = left;
        this.right = right;
    }

    public GraphLeaf left() {
        return left;
    }

    public GraphLeaf right() {
        return right;
    }
}
