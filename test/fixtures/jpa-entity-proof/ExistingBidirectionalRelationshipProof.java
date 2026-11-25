import jakarta.persistence.JoinColumn;
import jakarta.persistence.ManyToOne;
import jakarta.persistence.OneToMany;
import java.util.List;
import org.hibernate.boot.MetadataSources;
import org.hibernate.boot.registry.StandardServiceRegistryBuilder;

public class ExistingBidirectionalRelationshipProof {
    public static void main(String[] args) throws Exception {
        Class<?> child = Class.forName(args[0]);
        Class<?> parent = Class.forName(args[1]);
        var owning = child.getDeclaredField("parentReference");
        var join = owning.getAnnotation(JoinColumn.class);
        var inverse = parent.getDeclaredField("children").getAnnotation(OneToMany.class);
        require(owning.isAnnotationPresent(ManyToOne.class) && owning.getType().equals(parent) &&
            join.insertable() && join.updatable(), "the child association owns writes");
        require(inverse.mappedBy().equals(owning.getName()), "the inverse uses the exact child field");

        var registry = new StandardServiceRegistryBuilder()
            .applySetting("hibernate.hbm2ddl.auto", "none")
            .applySetting("hibernate.physical_naming_strategy", "org.hibernate.boot.model.naming.PhysicalNamingStrategyStandardImpl")
            .applySetting("jakarta.persistence.jdbc.url", System.getenv("RB_GENERATED_ENTITY_JDBC_URL"))
            .applySetting("jakarta.persistence.jdbc.user", System.getenv("RB_GENERATED_ENTITY_JDBC_USER"))
            .applySetting("jakarta.persistence.jdbc.password", System.getenv("RB_GENERATED_ENTITY_JDBC_PASSWORD"))
            .build();
        try {
            try (var factory = new MetadataSources(registry).addAnnotatedClass(child).addAnnotatedClass(parent)
                    .buildMetadata().buildSessionFactory()) {
                try (var session = factory.openSession()) {
                    var transaction = session.beginTransaction();
                    Object owner = session.find(parent, 11L);
                    Object member = session.find(child, 21L);
                    require(child.getMethod("getParentReference").invoke(member) == owner, "child-to-parent readback");
                    var members = (List<?>) parent.getMethod("getChildren").invoke(owner);
                    require(members.size() == 1 && members.getFirst() == member, "parent-to-child readback");
                    Object inserted = child.getConstructor().newInstance();
                    child.getMethod("setId", Long.class).invoke(inserted, 22L);
                    child.getMethod("setParentReference", parent).invoke(inserted, owner);
                    session.persist(inserted);
                    session.flush();
                    session.clear();
                    owner = session.find(parent, 11L);
                    members = (List<?>) parent.getMethod("getChildren").invoke(owner);
                    require(members.size() == 2, "owning insert is visible from the inverse side");
                    require(child.getMethod("getParentReference").invoke(session.find(child, 22L)) == owner,
                        "owning insert stores the actual foreign key");
                    transaction.rollback();
                }
                try (var session = factory.openSession()) {
                    require(session.find(child, 22L) == null, "the association insert rolled back");
                }
            }
        } finally {
            StandardServiceRegistryBuilder.destroy(registry);
        }
        System.out.println("ROCKETBRAIN_JPA_EXISTING_JDBC_OK");
    }

    private static void require(boolean found, String message) {
        if (!found) throw new AssertionError(message);
    }
}
