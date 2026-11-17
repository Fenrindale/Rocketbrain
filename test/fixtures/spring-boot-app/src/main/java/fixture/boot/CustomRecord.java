package fixture.boot;
import jakarta.persistence.*;
import java.util.Set;
import java.util.LinkedHashSet;
import java.util.Date;
@Entity
@Table(name="rb_v5_record")
@SecondaryTable(name="rb_v5_record_extra",pkJoinColumns=@PrimaryKeyJoinColumn(name="record_id"))
public class CustomRecord extends AuditBase {
    @Embedded
    @AttributeOverrides({
        @AttributeOverride(name="address.city",column=@Column(name="home_city",length=80)),
        @AttributeOverride(name="address.postalCode",column=@Column(name="home_postal",length=20)),
        @AttributeOverride(name="phoneNumber",column=@Column(name="home_phone",length=30))
    })
    private ContactDetails contact;
    @Embedded
    @AssociationOverride(name="department",joinColumns=@JoinColumn(name="assigned_department_id"))
    private AssignmentInfo assignment;
    @Convert(converter=TrimUpperConverter.class)
    @Column(name="normalized_code",length=60) private String normalizedCode;
    @Enumerated(EnumType.STRING) @Column(name="record_state",length=20) private RecordState state;
    @Column(name="secret_note",table="rb_v5_record_extra",length=120) private String note;
    @Temporal(TemporalType.DATE) @Column(name="registered_on") private Date registeredOn;
    @Lob @Column(name="large_text") private String largeText;
    @Lob @Column(name="raw_data") private byte[] rawData;
    @ElementCollection
    @CollectionTable(name="rb_v5_record_tags",joinColumns=@JoinColumn(name="record_id"))
    @Column(name="tag_value",length=30) private Set<String> tags=new LinkedHashSet<>();
    @ManyToMany
    @JoinTable(name="rb_v5_record_departments",joinColumns=@JoinColumn(name="record_id"),inverseJoinColumns=@JoinColumn(name="department_id"))
    private Set<Department> departments=new LinkedHashSet<>();
    protected CustomRecord() {}
    public CustomRecord(Department department) {
        contact=new ContactDetails(new Address("Incheon","22345"),"555-0100");
        assignment=new AssignmentInfo(department);normalizedCode=" abc ";state=RecordState.ACTIVE;note="Secondary table note";
        registeredOn=java.sql.Date.valueOf("2026-11-13");largeText="Long text fixture";rawData=new byte[]{0,(byte)255,16};
        tags.add("blue");tags.add("green");departments.add(department);
    }
    public ContactDetails getContact(){return contact;}
    public AssignmentInfo getAssignment(){return assignment;}
    public String getNormalizedCode(){return normalizedCode;}
    public RecordState getState(){return state;}
    public String getNote(){return note;}
    public Date getRegisteredOn(){return registeredOn;}
    public String getLargeText(){return largeText;}
    public byte[] getRawData(){return rawData;}
    public Set<String> getTags(){return tags;}
    public Set<Department> getDepartments(){return departments;}
}
