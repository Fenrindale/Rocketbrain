import jakarta.persistence.JoinColumn;
import jakarta.persistence.ManyToOne;
import jakarta.persistence.Table;
import org.hibernate.boot.MetadataSources;
import org.hibernate.boot.registry.StandardServiceRegistryBuilder;

public class GeneratedScopedRelationshipProof {
    public static void main(String[] args) throws Exception {
        Class<?> node = Class.forName(args[0]);
        Class<?> external = Class.forName(args[1]);
        var parentField = node.getDeclaredField("parentReference");
        var externalField = node.getDeclaredField("remoteReference");
        var join = externalField.getAnnotation(JoinColumn.class);
        require(parentField.getType().equals(node) && parentField.isAnnotationPresent(ManyToOne.class), "self-reference owns the target type");
        require(externalField.getType().equals(external) && externalField.isAnnotationPresent(ManyToOne.class)
            && !join.insertable() && !join.updatable(), "external link is owned by scalar FK fields");
        var externalTable = external.getAnnotation(Table.class);
        require(externalTable.catalog().equals(args[2]), "explicit external catalog");
        require(externalTable.name().replace("\"", "").equals(node.getAnnotation(Table.class).name().replace("\"", "")), "same physical table name in both schemas");

        String url = System.getenv("RB_GENERATED_ENTITY_JDBC_URL");
        var configuration = new StandardServiceRegistryBuilder().applySetting("hibernate.hbm2ddl.auto", "none")
            .applySetting("hibernate.physical_naming_strategy", "org.hibernate.boot.model.naming.PhysicalNamingStrategyStandardImpl");
        if (url == null) {
            configuration.applySetting("hibernate.dialect", "org.hibernate.dialect.MySQLDialect");
            configuration.applySetting("hibernate.boot.allow_jdbc_metadata_access", "false");
        } else {
            configuration.applySetting("jakarta.persistence.jdbc.url", url);
            configuration.applySetting("jakarta.persistence.jdbc.user", System.getenv("RB_GENERATED_ENTITY_JDBC_USER"));
            configuration.applySetting("jakarta.persistence.jdbc.password", System.getenv("RB_GENERATED_ENTITY_JDBC_PASSWORD"));
        }
        var registry = configuration.build();
        try {
            try (var factory = new MetadataSources(registry).addAnnotatedClass(node).addAnnotatedClass(external).buildMetadata().buildSessionFactory()) {
                if (url != null) {
                    try (var session = factory.openSession()) {
                        var transaction = session.beginTransaction();
                        Object child = session.find(node, 12L);
                        require(node.getMethod("getId").invoke(node.getMethod("getParentReference").invoke(child)).equals(11L), "self FK readback");
                        require(external.getMethod("getId").invoke(node.getMethod("getRemoteReference").invoke(child)).equals(91L), "qualified external FK readback");
                        Object inserted = node.getConstructor().newInstance();
                        node.getMethod("setId", Long.class).invoke(inserted, 13L);
                        node.getMethod("setParentReference", node).invoke(inserted, child);
                        node.getMethod("setRemoteId", Long.class).invoke(inserted, 91L);
                        session.persist(inserted);
                        session.flush();
                        session.clear();
                        Object saved = session.find(node, 13L);
                        require(node.getMethod("getId").invoke(node.getMethod("getParentReference").invoke(saved)).equals(12L), "association-owned self FK write");
                        require(external.getMethod("getId").invoke(node.getMethod("getRemoteReference").invoke(saved)).equals(91L), "scalar-owned external FK write");
                        transaction.rollback();
                    }
                    try (var session = factory.openSession()) {
                        require(session.find(node, 13L) == null, "transaction rolled back");
                    }
                }
            }
        } finally {
            StandardServiceRegistryBuilder.destroy(registry);
        }
        System.out.println(url == null ? "ROCKETBRAIN_JPA_SCOPED_BIND_OK" : "ROCKETBRAIN_JPA_SCOPED_JDBC_OK");
    }

    private static void require(boolean found, String reason) {
        if (!found) throw new AssertionError(reason);
    }
}
