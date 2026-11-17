package fixture.boot;
public class XmlRecord {
    private Long id;
    private String label;
    private String runtimeOnly;
    public XmlRecord() {}
    public XmlRecord(String label){this.label=label;this.runtimeOnly="not persistent";}
    public Long getId(){return id;}
    public String getLabel(){return label;}
    public String getRuntimeOnly(){return runtimeOnly;}
}
