package fixture.contextchild;

import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;

@Entity
@Table(name="rb_context_child")
public class ContextChildRow {
    @Id Long id;
    String note;
}
