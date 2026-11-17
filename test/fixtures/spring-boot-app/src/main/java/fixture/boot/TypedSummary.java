package fixture.boot;
public class TypedSummary {
    private final String name;
    private final Long total;
    public TypedSummary(String name,Long total){this.name=name;this.total=total;}
    public String getName(){return name;}
    public Long getTotal(){return total;}
}
