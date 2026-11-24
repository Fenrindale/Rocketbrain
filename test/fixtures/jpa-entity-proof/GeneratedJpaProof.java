import java.math.BigDecimal;
import java.time.LocalDate;
import java.time.LocalDateTime;

import jakarta.persistence.IdClass;
import org.hibernate.boot.MetadataSources;
import org.hibernate.boot.registry.StandardServiceRegistryBuilder;

public class GeneratedJpaProof {
    public static void main(String[] args) throws Exception {
        Class<?> account = Class.forName(args[0]);
        Class<?> entry = Class.forName(args[1]);
        Class<?> key = entry.getAnnotation(IdClass.class).value();
        var newKey = key.getConstructor(Integer.class, Long.class);
        Object identity = newKey.newInstance(17, 8765432101L);
        Object equalIdentity = newKey.newInstance(17, 8765432101L);
        Object differentIdentity = newKey.newInstance(18, 8765432101L);
        require(identity.equals(equalIdentity) && identity.hashCode() == equalIdentity.hashCode()
            && !identity.equals(differentIdentity), "composite ID equality");

        var registry = new StandardServiceRegistryBuilder()
            .applySetting("jakarta.persistence.jdbc.url", System.getenv("RB_GENERATED_ENTITY_JDBC_URL"))
            .applySetting("jakarta.persistence.jdbc.user", System.getenv("RB_GENERATED_ENTITY_JDBC_USER"))
            .applySetting("jakarta.persistence.jdbc.password", System.getenv("RB_GENERATED_ENTITY_JDBC_PASSWORD"))
            .applySetting("hibernate.hbm2ddl.auto", "none")
            .applySetting("hibernate.physical_naming_strategy", "org.hibernate.boot.model.naming.PhysicalNamingStrategyStandardImpl")
            .build();
        try {
            try (var factory = new MetadataSources(registry).addAnnotatedClass(account).addAnnotatedClass(entry)
                    .buildMetadata().buildSessionFactory(); var session = factory.openSession()) {
                Object accountRow = session.find(account, Long.valueOf(args[2]));
                require(accountRow != null, "auto-increment account lookup");
                require(account.getMethod("getOrder").invoke(accountRow).equals("reviewed"), "delimited SQL column");
                require(account.getMethod("getAmount").invoke(accountRow).equals(new BigDecimal("12.3400")), "decimal precision and scale");
                require(account.getMethod("getRecordedAt").invoke(accountRow).equals(LocalDateTime.parse("2026-03-15T08:09:10.123456")), "datetime fractions");
                require(account.getMethod("getRecordedOn").invoke(accountRow).equals(LocalDate.parse("2026-03-15")), "date mapping");
                require(account.getMethod("getActive").invoke(accountRow).equals(Boolean.TRUE), "bit(1) mapping");
                require(account.getMethod("getCategory").invoke(accountRow).equals("GO"), "char mapping");
                require(account.getMethod("getRating").invoke(accountRow).equals(3.25d), "double mapping");
                require(account.getMethod("getSequenceNumber").invoke(accountRow).equals((short) 10), "smallint mapping");
                require(account.getMethod("getNullableLabel").invoke(accountRow) == null, "nullable column mapping");
                Object entryRow = session.find(entry, identity);
                require(entryRow != null, "composite key lookup");
                require(entry.getMethod("getAccountId").invoke(entryRow).equals(Long.valueOf(args[2])), "scalar FK mapping");
                require(session.find(entry, differentIdentity) == null, "composite key selectivity");
            }
        } finally {
            StandardServiceRegistryBuilder.destroy(registry);
        }
        System.out.println("ROCKETBRAIN_JPA_ENTITY_READBACK_OK");
    }

    private static void require(boolean found, String reason) {
        if (!found) throw new AssertionError(reason);
    }
}
