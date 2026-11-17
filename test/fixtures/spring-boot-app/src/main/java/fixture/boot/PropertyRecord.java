package fixture.boot;
import jakarta.persistence.*;
@Entity
@Table(name="rb_spring_property")
@Access(AccessType.PROPERTY)
public class PropertyRecord {
    private Long id;
    private String externalCode;
    private String displayAlias="Alias-A";
    private String quotedValue="Quoted-A";
    protected PropertyRecord() {}
    public PropertyRecord(String code) { this.externalCode=code; }
    @Id @GeneratedValue(strategy=GenerationType.IDENTITY) @Column(name="id")
    public Long getId() { return id; }
    public void setId(Long id) { this.id=id; }
    @Column(name="external_code", nullable=false)
    public String getExternalCode() { return externalCode; }
    public void setExternalCode(String code) { this.externalCode=code; }
    public String getDisplayAlias(){return displayAlias;}
    public void setDisplayAlias(String value){this.displayAlias=value;}
    @Column(name="`QuotedValue`") public String getQuotedValue(){return quotedValue;}
    public void setQuotedValue(String value){this.quotedValue=value;}
    @Transient public String getComputed() { return "not persistent"; }
}
