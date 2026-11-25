import jakarta.persistence.JoinColumn;
import jakarta.persistence.JoinColumns;
import jakarta.persistence.MapsId;
import java.util.Arrays;
import java.util.Collection;
import java.util.List;
import org.hibernate.boot.MetadataSources;
import org.hibernate.boot.registry.StandardServiceRegistryBuilder;

public class DerivedIdentityRelationshipProof {
    public static void main(String[] args) throws Exception {
        Class<?> overrideChild = Class.forName(args[0]);
        Class<?> overrideParent = Class.forName(args[1]);
        Class<?> overrideKey = Class.forName(args[2]);
        Class<?> derivedChild = Class.forName(args[3]);
        Class<?> derivedParent = Class.forName(args[4]);
        Class<?> derivedKey = Class.forName(args[5]);
        var compositeJoin = overrideChild.getDeclaredField("parentReference").getAnnotation(JoinColumns.class);
        require(Arrays.stream(compositeJoin.value()).map(JoinColumn::referencedColumnName).toList().equals(List.of("tenant_id", "account_id")),
            "composite join references the overridden physical columns");
        var derivedField = derivedChild.getDeclaredField("ownerReference");
        require(derivedField.getAnnotation(MapsId.class).value().equals("owner"), "association supplies the exact embedded key member");
        var join = derivedField.getAnnotation(JoinColumn.class);
        require(join.name().equals("owner_fk") && join.insertable() && join.updatable(), "derived association owns the physical FK");
        Object firstKey = key(overrideKey, 5L, 11L);
        Object secondKey = key(overrideKey, 6L, 11L);
        Object derivedExisting = key(derivedKey, 51L, 7L);
        Object derivedInserted = key(derivedKey, 52L, 8L);
        var registry = new StandardServiceRegistryBuilder()
            .applySetting("hibernate.hbm2ddl.auto", "none")
            .applySetting("hibernate.physical_naming_strategy", "org.hibernate.boot.model.naming.PhysicalNamingStrategyStandardImpl")
            .applySetting("jakarta.persistence.jdbc.url", System.getenv("RB_GENERATED_ENTITY_JDBC_URL"))
            .applySetting("jakarta.persistence.jdbc.user", System.getenv("RB_GENERATED_ENTITY_JDBC_USER"))
            .applySetting("jakarta.persistence.jdbc.password", System.getenv("RB_GENERATED_ENTITY_JDBC_PASSWORD"))
            .build();
        try {
            try (var factory = new MetadataSources(registry).addAnnotatedClass(overrideChild).addAnnotatedClass(overrideParent)
                    .addAnnotatedClass(derivedChild).addAnnotatedClass(derivedParent).buildMetadata().buildSessionFactory()) {
                var identifiers = factory.getPersistenceUnitUtil();
                try (var session = factory.openSession()) {
                    var transaction = session.beginTransaction();
                    Object first = session.find(overrideParent, firstKey);
                    Object second = session.find(overrideParent, secondKey);
                    Object child = session.find(overrideChild, 21L);
                    Object firstOwner = session.find(derivedParent, 51L);
                    Object secondOwner = session.find(derivedParent, 52L);
                    Object dependent = session.find(derivedChild, derivedExisting);
                    require(get(child, overrideChild, "getParentReference") == first && onlyChild(first, overrideParent, child) &&
                        children(second, overrideParent).isEmpty(), "overridden tuples map both directions and distinguish the two tenants");
                    require(get(dependent, derivedChild, "getOwnerReference") == firstOwner && onlyChild(firstOwner, derivedParent, dependent) &&
                        children(secondOwner, derivedParent).isEmpty(), "derived identity maps both directions and distinguishes the two owners");

                    Object overriddenInsert = overrideChild.getConstructor().newInstance();
                    overrideChild.getMethod("setId", Long.class).invoke(overriddenInsert, 22L);
                    overrideChild.getMethod("setParentReference", overrideParent).invoke(overriddenInsert, second);
                    Object derivedInsert = derivedChild.getConstructor().newInstance();
                    derivedChild.getMethod("setIdentity", derivedKey).invoke(derivedInsert, key(derivedKey, null, 8L));
                    derivedChild.getMethod("setOwnerReference", derivedParent).invoke(derivedInsert, secondOwner);
                    session.persist(overriddenInsert);
                    session.persist(derivedInsert);
                    session.flush();
                    require(derivedInserted.equals(identifiers.getIdentifier(derivedInsert)), "Hibernate copies the owner key into the embedded ID");
                    session.clear();

                    Object overrideWritten = session.find(overrideChild, 22L);
                    Object derivedWritten = session.find(derivedChild, derivedInserted);
                    require(secondKey.equals(identifiers.getIdentifier(get(overrideWritten, overrideChild, "getParentReference"))),
                        "insert uses the overridden parent key tuple");
                    require(Long.valueOf(52L).equals(identifiers.getIdentifier(get(derivedWritten, derivedChild, "getOwnerReference"))) &&
                        onlyChild(session.find(derivedParent, 52L), derivedParent, derivedWritten), "insert uses the derived physical tuple");
                    transaction.rollback();
                }
                try (var session = factory.openSession()) {
                    require(session.find(overrideChild, 22L) == null && session.find(derivedChild, derivedInserted) == null,
                        "both transaction-local inserts were rolled back");
                }
            }
        } finally {
            StandardServiceRegistryBuilder.destroy(registry);
        }
        System.out.println("ROCKETBRAIN_JPA_DERIVED_IDENTITY_JDBC_OK");
    }

    private static Object key(Class<?> type, Long first, Long second) throws Exception {
        return type.getConstructor(Long.class, Long.class).newInstance(first, second);
    }

    private static Object get(Object instance, Class<?> type, String getter) throws Exception {
        return type.getMethod(getter).invoke(instance);
    }

    private static Collection<?> children(Object parent, Class<?> type) throws Exception {
        return (Collection<?>) get(parent, type, "getChildren");
    }

    private static boolean onlyChild(Object parent, Class<?> type, Object child) throws Exception {
        var values = children(parent, type);
        return values.size() == 1 && values.iterator().next() == child;
    }

    private static void require(boolean found, String description) {
        if (!found) throw new AssertionError(description);
    }
}
