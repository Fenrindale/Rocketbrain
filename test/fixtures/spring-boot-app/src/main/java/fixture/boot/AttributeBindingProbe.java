package fixture.boot;

import jakarta.persistence.AttributeConverter;
import jakarta.persistence.Column;
import jakarta.persistence.Convert;
import jakarta.persistence.Converter;
import jakarta.persistence.Embeddable;
import jakarta.persistence.Embedded;
import jakarta.persistence.Entity;
import jakarta.persistence.EntityManager;
import jakarta.persistence.Id;
import jakarta.persistence.PersistenceContext;
import jakarta.persistence.Table;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class AttributeBindingProbe {
    private static final AtomicInteger unitWrites = new AtomicInteger(), unitReads = new AtomicInteger();
    private static final AtomicInteger labelWrites = new AtomicInteger(), labelReads = new AtomicInteger();

    public record Units(long count) {}

    @Converter
    public static class UnitsConverter implements AttributeConverter<Units,Long> {
        @Override public Long convertToDatabaseColumn(Units value) {
            unitWrites.incrementAndGet();
            return value == null ? null : value.count();
        }
        @Override public Units convertToEntityAttribute(Long value) {
            unitReads.incrementAndGet();
            return value == null ? null : new Units(value);
        }
    }

    @Converter
    public static class LabelConverter implements AttributeConverter<String,String> {
        @Override public String convertToDatabaseColumn(String value) {
            labelWrites.incrementAndGet();
            return value == null ? null : value.strip().toUpperCase(Locale.ROOT);
        }
        @Override public String convertToEntityAttribute(String value) {
            labelReads.incrementAndGet();
            return value;
        }
    }

    @PersistenceContext
    private EntityManager manager;

    @GetMapping("/probe/jpa-attribute-binding/read")
    @Transactional(readOnly=true)
    Map<String,Integer> read() {
        var entries = manager.createQuery("""
                select entry from AttributeBindingEntry entry
                where entry.units = :units and entry.labels.normalized = :label
                """, AttributeBindingEntry.class)
            .setParameter("units", new Units(678391270581901L))
            .setParameter("label", "  rb_binding_3704  ")
            .getResultList();
        return Map.of("matched", entries.size());
    }

    @GetMapping("/probe/jpa-attribute-binding/counters")
    Map<String,Integer> counters() {
        return Map.of("unitWrites",unitWrites.get(),"unitReads",unitReads.get(),
            "labelWrites",labelWrites.get(),"labelReads",labelReads.get());
    }
}

@Entity
@Table(name="rb_attribute_binding")
class AttributeBindingEntry {
    @Id Long id;

    @Column(name="unit_count")
    @Convert(converter=AttributeBindingProbe.UnitsConverter.class)
    AttributeBindingProbe.Units units;

    @Embedded AttributeBindingLabels labels;

    @Column(name="plain_note")
    String note;
}

@Embeddable
class AttributeBindingLabels {
    @Column(name="label_text")
    @Convert(converter=AttributeBindingProbe.LabelConverter.class)
    String normalized;
}
