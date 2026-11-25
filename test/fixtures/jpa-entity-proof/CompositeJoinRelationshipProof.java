import jakarta.persistence.JoinColumns;
import jakarta.persistence.JoinTable;
import jakarta.persistence.ManyToMany;
import java.util.Collection;
import java.util.Set;
import org.hibernate.boot.MetadataSources;
import org.hibernate.boot.registry.StandardServiceRegistryBuilder;

public class CompositeJoinRelationshipProof {
    public static void main(String[] args) throws Exception {
        Class<?> child = Class.forName(args[0]);
        Class<?> parent = Class.forName(args[1]);
        Class<?> owner = Class.forName(args[2]);
        Class<?> target = Class.forName(args[3]);
        var direct = child.getDeclaredField("parentReference").getAnnotation(JoinColumns.class);
        require(direct.value().length == 2 && direct.value()[0].referencedColumnName().equals("tenant_id")
            && direct.value()[1].referencedColumnName().equals("id"), "direct relation uses the full ordered key");
        var through = owner.getDeclaredField("tags").getAnnotation(JoinTable.class);
        require(through.catalog().equals(args[4]) && through.name().replace("\"", "").equals(args[5]) &&
            through.joinColumns().length == 1 && through.inverseJoinColumns().length == 2,
            "join table is qualified and both column groups are explicit");
        var inverse = target.getDeclaredField("owners").getAnnotation(ManyToMany.class);
        require(inverse.mappedBy().equals("tags"), "inverse relation identifies its exact owner");

        var registry = new StandardServiceRegistryBuilder()
            .applySetting("hibernate.hbm2ddl.auto", "none")
            .applySetting("hibernate.physical_naming_strategy", "org.hibernate.boot.model.naming.PhysicalNamingStrategyStandardImpl")
            .applySetting("jakarta.persistence.jdbc.url", System.getenv("RB_GENERATED_ENTITY_JDBC_URL"))
            .applySetting("jakarta.persistence.jdbc.user", System.getenv("RB_GENERATED_ENTITY_JDBC_USER"))
            .applySetting("jakarta.persistence.jdbc.password", System.getenv("RB_GENERATED_ENTITY_JDBC_PASSWORD"))
            .build();
        try {
            try (var factory = new MetadataSources(registry).addAnnotatedClass(child).addAnnotatedClass(parent)
                    .addAnnotatedClass(owner).addAnnotatedClass(target).buildMetadata().buildSessionFactory()) {
                try (var session = factory.openSession()) {
                    var transaction = session.beginTransaction();
                    Object firstParent = session.find(parent, key(parent, 5L, 11L));
                    Object secondParent = session.find(parent, key(parent, 6L, 11L));
                    Object storedChild = session.find(child, 21L);
                    require(call(child, "getParentReference", storedChild) == firstParent, "two-column FK joins the exact tenant");
                    require(onlyElement(children(parent, firstParent), storedChild) && children(parent, secondParent).isEmpty(),
                        "inverse collection uses both FK columns");
                    Object firstTarget = session.find(target, key(target, 7L, 41L));
                    Object secondTarget = session.find(target, key(target, 8L, 41L));
                    Object storedOwner = session.find(owner, 31L);
                    require(onlyElement(links(owner, "getTags", storedOwner), firstTarget), "qualified join returns the correct remote tenant");
                    require(onlyElement(links(target, "getOwners", firstTarget), storedOwner) &&
                        links(target, "getOwners", secondTarget).isEmpty(), "qualified join traverses its inverse");

                    Object inserted = child.getConstructor().newInstance();
                    child.getMethod("setId", Long.class).invoke(inserted, 22L);
                    child.getMethod("setParentReference", parent).invoke(inserted, secondParent);
                    session.persist(inserted);
                    links(owner, "getTags", storedOwner).add(secondTarget);
                    session.flush();
                    session.clear();
                    require(call(child, "getParentReference", session.find(child, 22L)) == session.find(parent, key(parent, 6L, 11L)),
                        "writing through the child association stores both FK columns");
                    Object reloadedOwner = session.find(owner, 31L);
                    require(onlyElement(links(target, "getOwners", session.find(target, key(target, 8L, 41L))), reloadedOwner),
                        "writing through the owner persists a cross-schema link");
                    transaction.rollback();
                }
                try (var session = factory.openSession()) {
                    require(session.find(child, 22L) == null, "composite FK insert rolled back");
                    Object originalTarget = session.find(target, key(target, 7L, 41L));
                    require(onlyElement(links(owner, "getTags", session.find(owner, 31L)), originalTarget), "cross-schema link insert rolled back");
                }
            }
        } finally {
            StandardServiceRegistryBuilder.destroy(registry);
        }
        System.out.println("ROCKETBRAIN_JPA_COMPOSITE_JOIN_JDBC_OK");
    }

    private static Object key(Class<?> entity, Long tenant, Long id) throws Exception {
        return Class.forName(entity.getName() + "$Key").getConstructor(Long.class, Long.class).newInstance(tenant, id);
    }

    private static Object call(Class<?> entity, String accessor, Object value) throws Exception {
        return entity.getMethod(accessor).invoke(value);
    }

    private static Collection<?> children(Class<?> entity, Object value) throws Exception {
        return (Collection<?>) call(entity, "getChildren", value);
    }

    @SuppressWarnings("unchecked")
    private static Set<Object> links(Class<?> entity, String accessor, Object value) throws Exception {
        return (Set<Object>) call(entity, accessor, value);
    }

    private static boolean onlyElement(Collection<?> values, Object expected) {
        return values.size() == 1 && values.iterator().next() == expected;
    }

    private static void require(boolean found, String message) {
        if (!found) throw new AssertionError(message);
    }
}
