package fixture.boot;
import jakarta.persistence.*;
@Entity(name="AnnotationName") @Table(name="rb_v5_wrong_annotated_table")
public class XmlOverrideRecord {
    @Id @GeneratedValue(strategy=GenerationType.IDENTITY) private Long id;
    @Column(name="wrong_annotated_column") private String label;
    protected XmlOverrideRecord() {}
    public XmlOverrideRecord(String label){this.label=label;}
    public Long getId(){return id;}
    public String getLabel(){return label;}
}
