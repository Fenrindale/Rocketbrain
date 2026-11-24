import jakarta.persistence.JoinColumn;
import jakarta.persistence.JoinColumns;
import jakarta.persistence.ManyToOne;
import jakarta.persistence.OneToOne;
import org.hibernate.boot.MetadataSources;
import org.hibernate.boot.registry.StandardServiceRegistryBuilder;

public class GeneratedRelationshipProof {
    public static void main(String[] args) throws Exception {
        Class<?> account = Class.forName(args[0]);
        Class<?> profile = Class.forName(args[1]);
        Class<?> membership = Class.forName(args[2]);
        var accountField = membership.getDeclaredField("accountReference");
        var profileField = membership.getDeclaredField("profileReference");
        var join = accountField.getAnnotation(JoinColumn.class);
        require(accountField.isAnnotationPresent(ManyToOne.class) && join.insertable() && join.updatable(), "writable many-to-one");
        var joins = profileField.getAnnotation(JoinColumns.class).value();
        require(profileField.isAnnotationPresent(OneToOne.class) && joins.length == 2, "unique composite one-to-one");
        for (var item : joins) require(!item.insertable() && !item.updatable(), "scalar join column ownership");

        String url = System.getenv("RB_GENERATED_ENTITY_JDBC_URL");
        var configuration = new StandardServiceRegistryBuilder()
            .applySetting("hibernate.hbm2ddl.auto", "none")
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
            try (var factory = new MetadataSources(registry).addAnnotatedClass(account).addAnnotatedClass(profile)
                    .addAnnotatedClass(membership).buildMetadata().buildSessionFactory()) {
                if (url != null) {
                    Long accountId = Long.valueOf(args[3]);
                    Long originalId = Long.valueOf(args[4]);
                    Long generatedId;
                    try (var session = factory.openSession()) {
                        var transaction = session.beginTransaction();
                        Object original = session.find(membership, originalId);
                        Object readAccount = membership.getMethod("getAccountReference").invoke(original);
                        Object readProfile = membership.getMethod("getProfileReference").invoke(original);
                        require(account.getMethod("getId").invoke(readAccount).equals(accountId), "ordinary FK readback");
                        require(profile.getMethod("getTenantId").invoke(readProfile).equals(17), "composite tenant FK readback");
                        require(profile.getMethod("getEntryId").invoke(readProfile).equals(8765432101L), "composite entry FK readback");
                        require(membership.getMethod("getProfileTenantId").invoke(original).equals(17), "scalar column remains readable");

                        Object newRow = membership.getConstructor().newInstance();
                        membership.getMethod("setAccountReference", account).invoke(newRow, readAccount);
                        membership.getMethod("setProfileTenantId", Integer.class).invoke(newRow, 18);
                        membership.getMethod("setProfileEntryId", Long.class).invoke(newRow, 8765432102L);
                        session.persist(newRow);
                        session.flush();
                        generatedId = (Long) membership.getMethod("getId").invoke(newRow);
                        require(generatedId != null, "generated ID");
                        session.clear();
                        Object saved = session.find(membership, generatedId);
                        Object savedAccount = membership.getMethod("getAccountReference").invoke(saved);
                        Object savedProfile = membership.getMethod("getProfileReference").invoke(saved);
                        require(account.getMethod("getId").invoke(savedAccount).equals(accountId), "association-owned FK write");
                        require(profile.getMethod("getTenantId").invoke(savedProfile).equals(18), "scalar-owned composite tenant write");
                        require(profile.getMethod("getEntryId").invoke(savedProfile).equals(8765432102L), "scalar-owned composite entry write");
                        transaction.rollback();
                    }
                    try (var session = factory.openSession()) {
                        require(session.find(membership, generatedId) == null, "transaction rolled back");
                    }
                }
            }
        } finally {
            StandardServiceRegistryBuilder.destroy(registry);
        }
        System.out.println(url == null ? "ROCKETBRAIN_JPA_ASSOCIATION_BIND_OK" : "ROCKETBRAIN_JPA_ASSOCIATION_JDBC_OK");
    }

    private static void require(boolean found, String reason) {
        if (!found) throw new AssertionError(reason);
    }
}
