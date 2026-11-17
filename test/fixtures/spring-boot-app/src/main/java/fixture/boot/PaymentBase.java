package fixture.boot;
import jakarta.persistence.*;
import java.math.BigDecimal;
@Entity @Table(name="rb_v5_paymentbase") @Inheritance(strategy=InheritanceType.TABLE_PER_CLASS)
public abstract class PaymentBase {
    @Id @Column(name="id") protected Long id;
    @Column(name="amount",precision=12,scale=2) protected BigDecimal amount;
    public Long getId(){return id;}
    public BigDecimal getAmount(){return amount;}
}
