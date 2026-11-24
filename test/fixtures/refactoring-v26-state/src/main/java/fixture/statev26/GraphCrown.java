package fixture.statev26;

public final class GraphCrown {
    private final GraphBranch branch;
    private final GraphBranch mirrored;

    public GraphCrown(GraphBranch branch) {
        this.branch = branch;
        this.mirrored = branch;
    }

    public GraphBranch branch() {
        return branch;
    }

    public GraphBranch echo() {
        return mirrored;
    }
}
