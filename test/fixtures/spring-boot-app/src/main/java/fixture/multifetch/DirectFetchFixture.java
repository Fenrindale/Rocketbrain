package fixture.multifetch;

import jakarta.persistence.*;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

@Entity
@Table(name = "rb_fetch_multi_owner")
class DirectFetchOwner {
    @Id Long id;
    @ManyToOne(fetch = FetchType.LAZY) @JoinColumn(name = "left_note_id") DirectFetchNote leftNote;
    @ManyToOne(fetch = FetchType.LAZY) @JoinColumn(name = "right_note_id") DirectFetchNote rightNote;
    @OneToMany(mappedBy = "leftOwner", fetch = FetchType.LAZY) Set<DirectFetchMember> leftSet = new HashSet<>();
    @OneToMany(mappedBy = "rightOwner", fetch = FetchType.LAZY) Set<DirectFetchMember> rightSet = new HashSet<>();
    @ManyToMany(fetch = FetchType.LAZY)
    @JoinTable(name = "rb_fetch_multi_bag_left", joinColumns = @JoinColumn(name = "owner_id"), inverseJoinColumns = @JoinColumn(name = "member_id"))
    List<DirectFetchMember> leftBag = new ArrayList<>();
    @ManyToMany(fetch = FetchType.LAZY)
    @JoinTable(name = "rb_fetch_multi_bag_right", joinColumns = @JoinColumn(name = "owner_id"), inverseJoinColumns = @JoinColumn(name = "member_id"))
    List<DirectFetchMember> rightBag = new ArrayList<>();
}

@Entity
@Table(name = "rb_fetch_multi_note")
class DirectFetchNote {
    @Id Long id;
    String body;
    public String getBody() { throw new IllegalStateException("The snapshot reads the exact field"); }
}

@Entity
@Table(name = "rb_fetch_multi_member")
class DirectFetchMember {
    @Id Long id;
    String label;
    @ManyToOne(fetch = FetchType.LAZY) @JoinColumn(name = "left_owner_id") DirectFetchOwner leftOwner;
    @ManyToOne(fetch = FetchType.LAZY) @JoinColumn(name = "right_owner_id") DirectFetchOwner rightOwner;
}
