package fixture.boot;
import jakarta.persistence.*;
@Entity
@DiscriminatorValue("DOC")
public class DocumentAsset extends Asset {
    @Column(name="document_format") private String format;
    protected DocumentAsset() {}
    public DocumentAsset(String label, String format) { this.label=label; this.format=format; }
    public String getFormat() { return format; }
}
